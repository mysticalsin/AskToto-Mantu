import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { windowsPowerShell, windowsSignatureCommand } from './lib/signing-policy.mjs'

const boundary = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  platform: vi.fn(),
  homedir: vi.fn()
}))
vi.mock('node:child_process', () => ({ execFileSync: boundary.execFileSync }))
vi.mock('node:fs', () => ({
  existsSync: boundary.existsSync,
  readdirSync: boundary.readdirSync,
  statSync: boundary.statSync
}))
vi.mock('node:os', () => ({ platform: boundary.platform, homedir: boundary.homedir }))

const CERT = 'C:\\fixture-private-pfx\\certificate.pfx'
const PASS = 'fixture-private-signing-password'
const ARTIFACTS = "C:\\Build's [draft]\\release"
const TARGET = join(ARTIFACTS, 'Metis-Setup-1.8.10.exe')
const SDK_ROOT = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin'
const SDK_VERSION = join(SDK_ROOT, '10.0.22621.0')
const SDK_ARCH = join(SDK_VERSION, 'x64')
const SIGNTOOL = join(SDK_ARCH, 'signtool.exe')
const SIGNER = 'Metis Signing Fixture'
const RAW_OUTPUT = `private child output: ${CERT} ${PASS}`
const signature = {
  Status: 'Valid',
  Subject: `CN=${SIGNER}, O=Fixture`,
  CommonName: SIGNER,
  TimeStamperSubject: 'CN=Timestamp Fixture'
}

type FixtureNode = { directory: boolean; children?: string[] }
const nodes = new Map<string, FixtureNode>()
let originalArgv: string[]
let log: ReturnType<typeof vi.spyOn>
let error: ReturnType<typeof vi.spyOn>

class CliExit extends Error {
  constructor(readonly code: number) { super('synthetic CLI exit') }
}

async function run(): Promise<{ code: number; output: string }> {
  let code = 0
  try {
    await import('./sign-win.mjs')
  } catch (cause) {
    if (!(cause instanceof CliExit)) throw cause
    code = cause.code
  }
  return { code, output: [...log.mock.calls, ...error.mock.calls].flat().join('\n') }
}

function respondWith(value: unknown = signature, raw?: string): void {
  boundary.execFileSync.mockImplementation((command: string, args: string[]) => {
    if (command === SIGNTOOL) return 'synthetic signing success'
    if (!command.endsWith('powershell.exe')) throw new Error('unexpected synthetic command')
    // Model the actual old/new PowerShell command output: Status alone vs the complete policy JSON.
    if (raw !== undefined) return raw
    return args.at(-1)?.includes('ConvertTo-Json') ? JSON.stringify(value) : (value as typeof signature)?.Status
  })
}

function expectPrivate(result: { output: string }): void {
  expect(result.output).not.toContain(CERT)
  expect(result.output).not.toContain(PASS)
  expect(result.output).not.toContain(RAW_OUTPUT)
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  originalArgv = process.argv
  process.argv = ['node', 'sign-win.mjs', ARTIFACTS]
  vi.stubEnv('WIN_CSC_LINK', CERT)
  vi.stubEnv('WIN_CSC_KEY_PASSWORD', PASS)
  vi.stubEnv('WIN_CSC_EXPECTED_SUBJECT', SIGNER)
  vi.stubEnv('WIN_TIMESTAMP_URL', '')
  vi.stubEnv('ASKTOTO_ARTIFACTS_DIR', '')
  vi.stubEnv('SystemRoot', 'D:\\Windows')
  vi.stubEnv('windir', '')
  boundary.platform.mockReturnValue('win32')
  boundary.homedir.mockReturnValue('C:\\FixtureHome')
  nodes.clear()
  nodes.set(CERT, { directory: false })
  nodes.set(ARTIFACTS, { directory: true, children: ['Metis-Setup-1.8.10.exe'] })
  nodes.set(TARGET, { directory: false })
  nodes.set(SDK_ROOT, { directory: true, children: ['10.0.22621.0'] })
  nodes.set(SDK_VERSION, { directory: true, children: ['x64'] })
  nodes.set(SDK_ARCH, { directory: true, children: ['signtool.exe'] })
  nodes.set(SIGNTOOL, { directory: false })
  boundary.existsSync.mockImplementation((path: unknown) => nodes.has(String(path)))
  boundary.readdirSync.mockImplementation((path: unknown) => nodes.get(String(path))?.children || [])
  boundary.statSync.mockImplementation((path: unknown) => {
    const node = nodes.get(String(path))
    if (!node) throw new Error(RAW_OUTPUT)
    return { isDirectory: () => node.directory, isFile: () => !node.directory }
  })
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  error = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process, 'exit').mockImplementation((code) => { throw new CliExit(Number(code)) })
  respondWith()
})

afterEach(() => {
  process.argv = originalArgv
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('MQA-323 local Windows signing helper', () => {
  it('preserves local PFX, SHA256 and RFC3161 inputs while branding a valid target as Métis', async () => {
    const result = await run()
    expect(result.code).toBe(0)
    expect(boundary.execFileSync.mock.calls[0]).toEqual([
      SIGNTOOL,
      ['sign', '/f', CERT, '/p', PASS, '/fd', 'SHA256', '/tr', 'http://timestamp.digicert.com', '/td', 'SHA256', '/d', 'Métis', TARGET],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
    ])
    expect(result.output).toContain('PASS')
    expectPrivate(result)
  })

  it('rejects a missing password before running either system tool', async () => {
    vi.stubEnv('WIN_CSC_KEY_PASSWORD', '')
    const result = await run()
    expect(result.code).toBe(2)
    expect(boundary.execFileSync).not.toHaveBeenCalled()
    expectPrivate(result)
  })

  it.each(['darwin', 'linux'])('fails on unsupported signing host %s without claiming a skip success', async (host) => {
    boundary.platform.mockReturnValue(host)
    const result = await run()
    expect(result.code).toBe(2)
    expect(boundary.execFileSync).not.toHaveBeenCalled()
    expect(result.output).not.toContain('PASS')
  })

  it.each(['unset', 'missing', 'directory', 'unreadable'])('rejects a %s certificate path without revealing it', async (kind) => {
    if (kind === 'unset') vi.stubEnv('WIN_CSC_LINK', '')
    if (kind === 'missing') nodes.delete(CERT)
    if (kind === 'directory') nodes.set(CERT, { directory: true })
    if (kind === 'unreadable') boundary.statSync.mockImplementation(() => { throw new Error(RAW_OUTPUT) })
    const result = await run()
    expect(result.code).toBe(2)
    expect(boundary.execFileSync).not.toHaveBeenCalled()
    expectPrivate(result)
  })

  it('requires the expected publisher before signing any target', async () => {
    vi.stubEnv('WIN_CSC_EXPECTED_SUBJECT', '  ')
    const result = await run()
    expect(result.code).toBe(2)
    expect(boundary.execFileSync).not.toHaveBeenCalled()
    expect(result.output).toContain('WIN_CSC_EXPECTED_SUBJECT')
  })

  it('reports signing failure as a safe category and exit code, never child output or command text', async () => {
    boundary.execFileSync.mockImplementation(() => {
      throw Object.assign(new Error(RAW_OUTPUT), { status: 7, stdout: RAW_OUTPUT, stderr: RAW_OUTPUT })
    })
    const result = await run()
    expect(result.code).toBe(1)
    expect(result.output).toContain('SIGN_COMMAND_FAILED')
    expect(result.output).toContain('exit 7')
    expect(result.output).not.toContain('PASS')
    expectPrivate(result)
  })

  it('uses the shared absolute Windows PowerShell and literal-path verification command', async () => {
    const result = await run()
    expect(result.code).toBe(0)
    const [, args, options] = boundary.execFileSync.mock.calls[1]
    expect(boundary.execFileSync.mock.calls[1][0]).toBe(windowsPowerShell())
    expect(args).toEqual(['-NoProfile', '-NonInteractive', '-Command', windowsSignatureCommand(TARGET)])
    expect(args.at(-1)).toContain("Build''s [draft]")
    expect(options).toEqual(expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }))
  })

  it.each([
    ['wrong publisher', { ...signature, Subject: 'CN=Someone Else', CommonName: 'Someone Else' }, 'PUBLISHER_MISMATCH'],
    ['partial publisher match', { ...signature, Subject: `CN=${SIGNER} Impostor`, CommonName: `${SIGNER} Impostor` }, 'PUBLISHER_MISMATCH'],
    ['missing timestamp', { ...signature, TimeStamperSubject: '' }, 'TIMESTAMP_MISSING'],
    ['untrusted signature', { ...signature, Status: 'NotTrusted' }, 'SIGNATURE_INVALID'],
    ['missing signature', {}, 'SIGNATURE_INVALID']
  ])('rejects %s even when signing itself succeeds', async (_name, value, category) => {
    respondWith(value)
    const result = await run()
    expect(result.code).toBe(1)
    expect(result.output).toContain(category)
    expect(result.output).not.toContain('PASS')
    expectPrivate(result)
  })

  it('accepts the exact full certificate subject as the expected publisher', async () => {
    vi.stubEnv('WIN_CSC_EXPECTED_SUBJECT', signature.Subject)
    expect((await run()).code).toBe(0)
  })

  it('does not log arbitrary fields from failed signature-policy output', async () => {
    respondWith({ ...signature, Status: RAW_OUTPUT, Subject: RAW_OUTPUT, TimeStamperSubject: RAW_OUTPUT })
    const result = await run()
    expect(result.code).toBe(1)
    expectPrivate(result)
  })

  it('rejects malformed verifier output without echoing it', async () => {
    respondWith(undefined, RAW_OUTPUT)
    const result = await run()
    expect(result.code).toBe(1)
    expect(result.output).toContain('VERIFY_OUTPUT_INVALID')
    expectPrivate(result)
  })

  it('suppresses verifier subprocess output and unsafe error status fields', async () => {
    boundary.execFileSync.mockImplementation((command: string) => {
      if (command === SIGNTOOL) return ''
      throw Object.assign(new Error(RAW_OUTPUT), { status: RAW_OUTPUT, stdout: RAW_OUTPUT, stderr: RAW_OUTPUT })
    })
    const result = await run()
    expect(result.code).toBe(1)
    expect(result.output).toContain('VERIFY_COMMAND_FAILED')
    expectPrivate(result)
  })
})
