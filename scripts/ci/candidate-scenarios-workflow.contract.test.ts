import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RUNNER_LABELS, SCENARIOS } from '../qa/candidate-scenarios.mjs'
import { VARIANTS } from '../qa/provenance.mjs'
import { findUnpinnedUses } from './check-workflow-pins.mjs'

const root = join(__dirname, '..', '..')
const read = (name: string) => readFileSync(join(root, '.github', 'workflows', name), 'utf8').replace(/\r\n/g, '\n')
const workflow = read('candidate-scenarios.yml')
const lines = workflow.split('\n')

/** The lines of a block that starts at `header` and ends at the next line indented `indent` or less. */
function block(from: string[], header: string, indent: number): string[] {
  const start = from.findIndex((line) => line === header)
  expect(start, `block not found: ${header.trim()}`).toBeGreaterThan(-1)
  const body: string[] = []
  for (const line of from.slice(start + 1)) {
    if (line.trim() !== '' && line.length - line.trimStart().length <= indent) break
    body.push(line)
  }
  return body
}

/** Top-level keys of the jobs: block, in order. */
function jobNames(): string[] {
  return block(lines, 'jobs:', 0)
    .map((line) => line.match(/^ {2}([A-Za-z0-9_-]+):$/)?.[1])
    .filter((name): name is string => Boolean(name))
}

const job = (name: string) => block(lines, `  ${name}:`, 2)

/** A job's steps: each one the text from its `- ` line to the next. */
function steps(name: string): string[] {
  const result: string[] = []
  for (const line of block(job(name), '    steps:', 4)) {
    if (/^ {6}- /.test(line)) result.push(line)
    else if (result.length) result[result.length - 1] += `\n${line}`
  }
  return result
}

const stepIndex = (all: string[], fragment: string) => {
  const index = all.findIndex((step) => step.includes(fragment))
  expect(index, `step not found: ${fragment}`).toBeGreaterThan(-1)
  return index
}

describe('candidate-scenarios.yml', () => {
  it('is dispatched by hand only, with the candidate run, a scenario choice and one sha256 per platform', () => {
    const on = block(lines, 'on:', 0).filter((line) => /^ {2}\S/.test(line))
    expect(on).toEqual(['  workflow_dispatch:'])
    const inputs = block(lines, '    inputs:', 4)
    expect(inputs.filter((line) => /^ {6}\S/.test(line)).map((line) => line.trim())).toEqual([
      'candidate_run:',
      'scenario:',
      'mac_sha256:',
      'win_sha256:'
    ])
    expect(block(inputs, '      candidate_run:', 6)).toContain('        required: true')
    expect(workflow).toMatch(/^run-name: .*\$\{\{ inputs\.scenario \}\}.*\$\{\{ inputs\.candidate_run \}\}$/m)
  })

  it('offers exactly the registry scenarios as choices', () => {
    const scenario = block(block(lines, '    inputs:', 4), '      scenario:', 6)
    expect(scenario).toContain('        type: choice')
    const options = block(scenario, '        options:', 8).map((line) => line.trim().replace(/^- /, ''))
    expect(options).toEqual(Object.keys(SCENARIOS))
    expect(options).toContain('renderer-kill')
  })

  it('reads contents and actions only, uses no secrets, and pins every action by full SHA', () => {
    expect(block(lines, 'permissions:', 0).filter((line) => line.trim())).toEqual(['  contents: read', '  actions: read'])
    expect(lines.filter((line) => /^\s+permissions:/.test(line))).toEqual([])
    expect(workflow).not.toContain('secrets.')
    expect(findUnpinnedUses(workflow)).toEqual([])
    expect(workflow).not.toMatch(/npm run (dist|build|release)/)
  })

  it('guards on this repository and main, and refuses any run that is not a qa-candidate.yml dispatch on main', () => {
    const guard = job('guard')
    const repositoryGuard = "if: github.repository == 'mysticalsin/AskToto-Mantu' && github.ref == 'refs/heads/main'"
    expect(guard).toContain(`    ${repositoryGuard}`)
    expect(read('qa-candidate.yml')).toContain("github.repository == 'mysticalsin/AskToto-Mantu'")
    // qa-candidate.yml builds on main and release/1.9.x only; this lane stays narrower and takes main candidates only.
    const qaCandidate = read('qa-candidate.yml')
    const refGuard = qaCandidate.slice(qaCandidate.indexOf('case "$GITHUB_REF" in'), qaCandidate.indexOf('esac'))
    const refArms = refGuard.split('\n').map((line) => line.trim()).filter((line) => /^[^\s]+\)/.test(line))
    expect(refArms).toEqual(['refs/heads/main|refs/heads/release/1.9.x) ;;', '*)'])
    expect(refGuard.slice(refGuard.indexOf('*)'))).toMatch(/echo "::error::[^\n]*"\s+exit 1 ;;/)
    expect(guard).toContain('    runs-on: ubuntu-latest')
    const guardSteps = steps('guard')
    expect(guardSteps[stepIndex(guardSteps, 'candidate-scenarios.mjs resolve')]).toContain('>> "$GITHUB_OUTPUT"')
    const runGuard = guardSteps[stepIndex(guardSteps, 'candidate-scenarios.mjs guard')]
    expect(runGuard).toContain('gh api "repos/$GITHUB_REPOSITORY/actions/runs/$CANDIDATE_RUN"')
    expect(runGuard).toContain('node scripts/qa/candidate-scenarios.mjs guard candidate-run.json "$CANDIDATE_RUN"')
  })

  it('has one job per registry platform, on its hosted runner, gated by the guard', () => {
    const platforms = [...new Set(Object.values(SCENARIOS).flatMap((scenario) => Object.keys(scenario.platforms)))]
    expect(jobNames()).toEqual(['guard', ...platforms])
    for (const platform of platforms) {
      const body = job(platform)
      expect(body).toContain('    needs: guard')
      expect(body).toContain(`    if: needs.guard.outputs.${platform} == 'true'`)
      expect(body).toContain(`    runs-on: ${RUNNER_LABELS[platform as keyof typeof RUNNER_LABELS]}`)
      expect(block(job('guard'), '    outputs:', 4).join('\n')).toContain(`${platform}_sha256: \${{ steps.resolve.outputs.${platform}_sha256 }}`)
    }
  })

  it('installs the verified candidate bytes selected by sha256 into a fresh directory before the scenario', () => {
    const mac = steps('mac')
    const order = [
      '--name candidate-provenance',
      'node scripts/qa/provenance.mjs verify provenance/provenance.json assets "$VARIANT"',
      'jq -r .run.id provenance/provenance.json',
      'node scripts/qa/candidate-installer.mjs assets "$INSTALLER_SHA256" mac',
      'codesign --verify --deep --strict',
      'candidate-scenarios.mjs profile',
      'candidate-scenarios.mjs run'
    ].map((fragment) => stepIndex(mac, fragment))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    const install = mac[stepIndex(mac, 'codesign')]
    expect(install).toContain('target="$RUNNER_TEMP/candidate-install"')
    expect(install).toContain('mkdir "$target"')
    expect(install).toContain('hdiutil attach')
    expect(install).toContain('ditto -x -k "$INSTALLER" "$target"')
    expect(mac[stepIndex(mac, '--name "$ARTIFACT"')]).toContain('gh run download "$CANDIDATE_RUN"')
    expect(job('mac')).toContain('      ARTIFACT: ${{ needs.guard.outputs.mac_artifact }}')
  })

  it('can install every macOS installer a registry scenario may select: the promotable DMG and the QA zip', () => {
    const install = steps('mac').find((step) => step.includes('codesign --verify')) ?? ''
    const kinds = new Set(
      Object.values(SCENARIOS).flatMap((scenario) => {
        const mac = (scenario.platforms as Record<string, { variant: string }>).mac
        return mac ? VARIANTS[mac.variant as keyof typeof VARIANTS].assets('1.0.0').map((asset) => asset.slice(asset.lastIndexOf('.'))) : []
      })
    )
    expect([...kinds].sort()).toEqual(['.dmg', '.zip'])
    for (const kind of kinds) expect(install).toContain(`*${kind})`)
    expect(workflow).toContain('-f scenario=renderer-kill -f mac_sha256=<Metis DMG sha256 from SHA256SUMS.txt>')
  })

  it('authorises System Events GUI scripting from the registry after the install and before the scenario', () => {
    const mac = steps('mac')
    const grant = stepIndex(mac, 'candidate-scenarios.mjs grant-gui')
    expect(mac[grant]).toContain('node scripts/qa/candidate-scenarios.mjs grant-gui --scenario "$SCENARIO" --platform mac')
    expect(mac[grant]).not.toContain('continue-on-error')
    expect(mac[grant]).not.toMatch(/^\s+if:/m)
    expect(grant).toBeGreaterThan(stepIndex(mac, 'codesign --verify'))
    expect(grant).toBeLessThan(stepIndex(mac, 'candidate-scenarios.mjs run'))
    expect((SCENARIOS['renderer-kill'].platforms.mac as { guiScripting?: boolean }).guiScripting).toBe(true)
  })

  it('uploads the lane artifact on every run and fails only after the upload', () => {
    const mac = steps('mac')
    const scenario = mac[stepIndex(mac, 'candidate-scenarios.mjs run')]
    expect(scenario).toContain('id: scenario')
    expect(scenario).toContain('continue-on-error: true')
    const scan = mac[stepIndex(mac, 'candidate-scenarios.mjs scan')]
    expect(scan).toContain('id: scan')
    expect(scan).toContain('if: always()')
    expect(scan).toContain('continue-on-error: true')
    expect(scan).toContain('--account "$(id -un)"')

    const upload = stepIndex(mac, 'actions/upload-artifact@')
    expect(mac[upload]).toContain('if: always()')
    expect(mac[upload]).toContain('name: candidate-scenario-${{ inputs.scenario }}-mac')
    expect(mac[upload]).toContain('path: candidate-scenario/')
    expect(job('mac')).toContain('      OUT: candidate-scenario')

    expect(stepIndex(mac, 'candidate-scenarios.mjs scan')).toBeGreaterThan(stepIndex(mac, 'candidate-scenarios.mjs run'))
    expect(upload).toBeGreaterThan(stepIndex(mac, 'candidate-scenarios.mjs scan'))
    expect(mac).toHaveLength(upload + 2)
    const verdict = mac[upload + 1]
    expect(verdict).toContain("if: always() && (steps.scenario.outcome != 'success' || steps.scan.outcome != 'success')")
    expect(verdict).toContain('exit 1')
  })

  it('offers sidecar-boot-reaper, which runs on both the macOS and the Windows job', () => {
    const options = block(block(block(lines, '    inputs:', 4), '      scenario:', 6), '        options:', 8).map((line) => line.trim())
    expect(options).toContain('- sidecar-boot-reaper')
    expect(Object.keys(SCENARIOS['sidecar-boot-reaper'].platforms)).toEqual(['mac', 'win'])
    expect(job('win')).toContain('    runs-on: windows-latest')
  })

  it('hands the installed app to the scenario on macOS', () => {
    const mac = steps('mac')
    const install = mac[stepIndex(mac, 'codesign --verify --deep --strict')]
    expect(install).toContain('id: install')
    expect(install).toContain('echo "app=$app" >> "$GITHUB_OUTPUT"')
    const scenario = mac[stepIndex(mac, 'candidate-scenarios.mjs run')]
    expect(scenario).toContain('APP: ${{ steps.install.outputs.app }}')
    expect(scenario).toContain('--app "$APP"')
  })

  it('installs the verified Setup selected by win_sha256 silently into a fresh directory before the scenario on Windows', () => {
    const win = steps('win')
    const order = [
      '--name candidate-provenance',
      'node scripts/qa/provenance.mjs verify provenance/provenance.json assets "$VARIANT"',
      "require('./provenance/provenance.json').run.id",
      'node scripts/qa/candidate-installer.mjs assets "$INSTALLER_SHA256" win',
      "'/S', \"/D=$target\"",
      'candidate-scenarios.mjs profile --scenario "$SCENARIO" --platform win',
      'candidate-scenarios.mjs run'
    ].map((fragment) => stepIndex(win, fragment))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(job('win')).toContain('      INSTALLER_SHA256: ${{ needs.guard.outputs.win_sha256 }}')
    expect(job('win')).toContain('      ARTIFACT: ${{ needs.guard.outputs.win_artifact }}')
    expect(win[stepIndex(win, '--name "$ARTIFACT"')]).toContain('gh run download "$CANDIDATE_RUN"')

    const install = win[stepIndex(win, "'/S', \"/D=$target\"")]
    expect(install).toContain('id: install')
    expect(install).toContain('shell: pwsh')
    expect(install).toContain("$target = Join-Path $env:RUNNER_TEMP 'candidate-install'")
    expect(install).toContain('New-Item -ItemType Directory -Path $target')
    expect(install).toContain('-Wait -PassThru')
    expect(install).toContain('if ($install.ExitCode -ne 0)')
    expect(install).toContain("$app = Join-Path $target 'Metis.exe'")
    expect(install).toContain('Add-Content -Path $env:GITHUB_OUTPUT -Value "app=$app"')

    const scenario = win[stepIndex(win, 'candidate-scenarios.mjs run')]
    expect(scenario).toContain('--platform win')
    expect(scenario).toContain('APP: ${{ steps.install.outputs.app }}')
    expect(scenario).toContain('--app "$APP"')
  })

  it('uploads the Windows lane artifact on every run and fails only after the upload', () => {
    const win = steps('win')
    const scenario = win[stepIndex(win, 'candidate-scenarios.mjs run')]
    expect(scenario).toContain('id: scenario')
    expect(scenario).toContain('continue-on-error: true')
    const scan = win[stepIndex(win, 'candidate-scenarios.mjs scan')]
    expect(scan).toContain('id: scan')
    expect(scan).toContain('if: always()')
    expect(scan).toContain('continue-on-error: true')

    const upload = stepIndex(win, 'actions/upload-artifact@')
    expect(win[upload]).toContain('if: always()')
    expect(win[upload]).toContain('name: candidate-scenario-${{ inputs.scenario }}-win')
    expect(win[upload]).toContain('path: candidate-scenario/')
    expect(job('win')).toContain('      OUT: candidate-scenario')
    expect(stepIndex(win, 'candidate-scenarios.mjs scan')).toBeGreaterThan(stepIndex(win, 'candidate-scenarios.mjs run'))
    expect(upload).toBeGreaterThan(stepIndex(win, 'candidate-scenarios.mjs scan'))
    expect(win).toHaveLength(upload + 2)
    expect(win[upload + 1]).toContain("if: always() && (steps.scenario.outcome != 'success' || steps.scan.outcome != 'success')")
  })
})
