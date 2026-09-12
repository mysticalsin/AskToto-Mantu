import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import {
  assertSigningHost,
  selectSigningDirectory,
  windowsSignatureCommand,
  windowsSignatureProblem,
  windowsPowerShell
} from './lib/signing-policy.mjs'

const temporaryDirectories: string[] = []
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('MQA-300 release signature verification', () => {
  it('does not fall back to a stale build when the requested output directory is missing', () => {
    expect(selectSigningDirectory('missing-output', {}, (path) => path === 'release')).toEqual({
      directory: null,
      candidates: ['missing-output']
    })
    expect(selectSigningDirectory(undefined, { ASKTOTO_ARTIFACTS_DIR: 'missing-env-output' }, () => false)).toEqual({
      directory: null,
      candidates: ['missing-env-output']
    })
  })

  it('uses the current workspace output by default', () => {
    const result = selectSigningDirectory(undefined, {}, (path) => path === 'release')
    expect(result.directory).toBe('release')
    expect(result.candidates).toEqual(['release', 'dist'])
  })

  it('the CLI refuses a missing explicit directory even when a previous local build exists', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'metis-signing-'))
    temporaryDirectories.push(workspace)
    mkdirSync(join(workspace, 'release'))
    const result = spawnSync(process.execPath, [join(__dirname, 'verify-signing.mjs'), 'missing-output'], {
      cwd: workspace,
      encoding: 'utf8',
      env: { ...process.env, ASKTOTO_ARTIFACTS_DIR: '' }
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('missing-output')
    expect(result.stdout).not.toContain('PASS')
  })

  it('cannot report a signing pass on an unsupported host', () => {
    expect(() => assertSigningHost('linux')).toThrow('macOS or Windows')
    expect(() => assertSigningHost('darwin')).not.toThrow()
    expect(() => assertSigningHost('win32')).not.toThrow()
  })

  it('resolves signature verification through the Windows system tool', () => {
    expect(windowsPowerShell({ SystemRoot: 'D:\\Windows' })).toBe(
      'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    )
  })

  it.runIf(process.platform === 'win32')('loads the built-in signature module despite an inherited incompatible module path', () => {
    const executable = windowsPowerShell()
    const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command', windowsSignatureCommand(executable)], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, PSModulePath: 'Z:\\metis-nonexistent-modules' }
    })
    expect(result.status, result.stderr).toBe(0)
    const signature = JSON.parse(result.stdout.trim())
    expect(signature.Status).toBe('Valid')
    expect(signature.Subject).toBeTruthy()
  })

  it('quotes installer filenames as literals for PowerShell', () => {
    const command = windowsSignatureCommand("C:\\Build's\\Metis-Setup.exe")
    expect(command).toContain("-LiteralPath 'C:\\Build''s\\Metis-Setup.exe'")
  })

  const valid = {
    Status: 'Valid',
    Subject: 'CN=Metis Signing Fixture, O=Fixture',
    CommonName: 'Metis Signing Fixture',
    TimeStamperSubject: 'CN=Timestamp Fixture'
  }

  it('requires a valid, timestamped signature by the exact configured publisher', () => {
    expect(windowsSignatureProblem(valid, 'Metis Signing Fixture')).toBeNull()
    expect(windowsSignatureProblem(valid, valid.Subject)).toBeNull()
    expect(windowsSignatureProblem(valid, '')).toContain('WIN_CSC_EXPECTED_SUBJECT')
    expect(windowsSignatureProblem(valid, 'Metis')).toContain('exactly match')
    expect(windowsSignatureProblem({ ...valid, Status: 'NotTrusted' }, valid.CommonName)).toContain('NotTrusted')
    expect(windowsSignatureProblem({ ...valid, TimeStamperSubject: '' }, valid.CommonName)).toContain('timestamp')
  })

  it('fails closed on missing or malformed PowerShell output', () => {
    for (const signature of [undefined, null, {}, { Status: 'Valid' }]) {
      expect(windowsSignatureProblem(signature, valid.CommonName)).not.toBeNull()
    }
  })
})
