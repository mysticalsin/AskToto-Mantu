import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const workflow = readFileSync(join(root, '.github', 'workflows', 'windows-qa.yml'), 'utf8').replace(/\r\n/g, '\n')

function jobBlock(name: string): string {
  const lines = workflow.split('\n')
  const start = lines.findIndex((line) => line === `  ${name}:`)
  expect(start, `workflow job not found: ${name}`).toBeGreaterThan(-1)
  const block: string[] = []

  for (const line of lines.slice(start + 1)) {
    if (/^ {0,2}[A-Za-z_][A-Za-z0-9_-]*:/.test(line)) break
    block.push(line)
  }

  return block.join('\n')
}

function inputBlock(name: string): string {
  const lines = workflow.split('\n')
  const start = lines.findIndex((line) => line === `      ${name}:`)
  expect(start, `workflow input not found: ${name}`).toBeGreaterThan(-1)
  const block: string[] = []

  for (const line of lines.slice(start + 1)) {
    if (/^ {0,6}[A-Za-z_][A-Za-z0-9_-]*:/.test(line)) break
    block.push(line)
  }

  return block.join('\n')
}

const capabilities = jobBlock('capabilities')
const hkW = jobBlock('hk-w')

const probeKeys = [
  'runner.name',
  'runner.os',
  'image.os',
  'image.version',
  'os.caption',
  'os.build',
  'cpu.name',
  'cpu.logical_cores',
  'memory.total_gb',
  'gpu.adapters',
  'audio.devices',
  'user.interactive',
  'session.id',
  'uia.automation_element_available',
  'uia.invoke_action',
  'sendinput.symbol_available',
  'sendinput.key_action',
  'tray.notify_icon_action',
  'global_hotkey.register_action',
  'audio.default_capture_endpoint_action',
  'gpu.dxdiag_action',
  'onedrive.env_present',
  'edr.assumed'
]

describe('Windows QA workflow', () => {
  it('offers the hk-w and capabilities suites and documents both dispatch commands', () => {
    const suite = inputBlock('suite')
    expect(suite).toMatch(/options:\n\s+- hk-w\n\s+- capabilities\n?$/)
    expect(workflow).toContain('-f suite=hk-w -f candidate_run=<run id> -f sha256=<Setup sha256>')
    expect(workflow).toContain('-f suite=capabilities')
  })

  it('makes the installer inputs optional at dispatch', () => {
    expect(inputBlock('candidate_run')).toContain('required: false')
    expect(inputBlock('sha256')).toContain('required: false')
  })

  it('guards the capabilities job to main in this repository on a bounded hosted Windows runner', () => {
    expect(capabilities).toContain(
      "if: inputs.suite == 'capabilities' && github.repository == 'mysticalsin/AskToto-Mantu' && github.ref == 'refs/heads/main'"
    )
    expect(capabilities).toContain('runs-on: windows-latest')
    const timeout = capabilities.match(/timeout-minutes: (\d+)/)
    expect(timeout).not.toBeNull()
    expect(Number(timeout![1])).toBeLessThanOrEqual(10)
    expect(capabilities).toMatch(/permissions:\n {6}contents: read\n/)
    expect(capabilities).not.toMatch(/^ {6}actions: /m)
  })

  it('runs no repository code and uses no credentials in the capabilities job', () => {
    expect(capabilities).not.toContain('actions/checkout')
    expect(capabilities).not.toMatch(/secrets\./i)
    expect(capabilities).not.toContain('GH_TOKEN')
    expect(capabilities).not.toContain('github.token')
    expect(capabilities).not.toMatch(/\bnpm\b|\bnode\b|\bnpx\b/)
    expect(capabilities).not.toMatch(/scripts\//)
  })

  it('records every probe key and catches each probe error separately', () => {
    for (const key of probeKeys) {
      expect(capabilities, `probe key ${key}`).toContain(`Probe '${key}'`)
    }
    expect(capabilities).toContain('try { $value = (& $Body | Out-String).Trim() }')
    expect(capabilities).toContain('"ERROR: $($_.Exception.GetType().Name): $($_.Exception.Message)"')
    expect(capabilities).toContain('CTRL+ALT+F24')
  })

  it('declares the SendInput INPUT struct at its 40-byte x64 size', () => {
    expect(capabilities).toMatch(/LayoutKind\.Explicit, Size = 40\)\] public struct INPUT/)
  })

  it('uploads capabilities.txt, SHA256SUMS.txt and dxdiag.txt as windows-qa-capabilities', () => {
    expect(capabilities).toContain("'capabilities.txt'")
    expect(capabilities).toContain("'SHA256SUMS.txt'")
    expect(capabilities).toContain("'dxdiag.txt'")
    expect(capabilities).toContain('${{ runner.temp }}/windows-qa-capabilities/')
    expect(capabilities).toContain('name: windows-qa-capabilities')
    expect(capabilities).toContain('if-no-files-found: error')
    expect(capabilities).toContain('retention-days: 14')
  })

  it('makes hk-w fail on bad candidate inputs before npm ci or any download', () => {
    const steps = hkW.slice(hkW.indexOf('    steps:\n'))
    const guardAt = steps.indexOf("$env:CANDIDATE_RUN -notmatch '^[0-9]+$'")
    expect(guardAt).toBeGreaterThan(-1)
    expect(steps).toContain("$env:CANDIDATE_SHA256 -notmatch '^[0-9A-Fa-f]{64}$'")
    expect(steps.indexOf('- name: Require the candidate inputs')).toBe(steps.indexOf('- name:'))
    expect(guardAt).toBeLessThan(steps.indexOf('actions/checkout'))
    expect(guardAt).toBeLessThan(steps.indexOf('npm ci'))
    expect(guardAt).toBeLessThan(steps.indexOf('gh run download'))
  })
})
