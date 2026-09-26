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

  // Design §2.5: azure mode adds an EKU policy on top of the unchanged Status/subject/timestamp checks
  // above; pfx mode (the default policy, and every call above that omits a third argument) is untouched.
  describe('azure-mode EKU policy (design §2.5)', () => {
    const PUBLIC_TRUST = '1.3.6.1.4.1.311.97.1.0'
    const IDENTITY = '1.3.6.1.4.1.311.97.42.7'
    const LIFETIME_SIGNING = '1.3.6.1.4.1.311.10.3.13'
    const azureValid = { ...valid, EkuOids: [PUBLIC_TRUST, IDENTITY] }

    it('is not applied under the default (pfx) policy, even with no EKU data at all', () => {
      expect(windowsSignatureProblem(valid, valid.CommonName)).toBeNull()
      expect(windowsSignatureProblem({ ...valid, EkuOids: undefined }, valid.CommonName, { mode: 'pfx' })).toBeNull()
    })

    it('passes an azure signature carrying the Public Trust EKU', () => {
      expect(windowsSignatureProblem(azureValid, valid.CommonName, { mode: 'azure' })).toBeNull()
    })

    it('requires the Public Trust EKU in azure mode', () => {
      expect(windowsSignatureProblem({ ...valid, EkuOids: [IDENTITY] }, valid.CommonName, { mode: 'azure' }))
        .toContain(PUBLIC_TRUST)
    })

    it('rejects the lifetime-signing EKU of a Public Trust Test certificate even alongside Public Trust', () => {
      const testProfile = { ...valid, EkuOids: [PUBLIC_TRUST, LIFETIME_SIGNING] }
      expect(windowsSignatureProblem(testProfile, valid.CommonName, { mode: 'azure' })).toContain('lifetime-signing')
    })

    it('optionally requires the exact configured identity EKU', () => {
      expect(windowsSignatureProblem(azureValid, valid.CommonName, { mode: 'azure', identityEku: IDENTITY })).toBeNull()
      expect(windowsSignatureProblem(azureValid, valid.CommonName, { mode: 'azure', identityEku: '1.3.6.1.4.1.311.97.99.9' }))
        .toContain('identity EKU')
      // No identityEku configured: only the Public Trust / lifetime-signing checks apply.
      expect(windowsSignatureProblem(azureValid, valid.CommonName, { mode: 'azure' })).toBeNull()
    })

    it('fails closed on missing or malformed EKU output in azure mode', () => {
      for (const ekuOids of [undefined, null, 'not-an-array', {}]) {
        expect(windowsSignatureProblem({ ...valid, EkuOids: ekuOids }, valid.CommonName, { mode: 'azure' }))
          .toContain('enhanced key usage')
      }
    })

    it('still enforces Status/subject/timestamp before ever reaching the EKU checks', () => {
      expect(windowsSignatureProblem({ ...azureValid, Status: 'NotTrusted' }, valid.CommonName, { mode: 'azure' }))
        .toContain('NotTrusted')
      expect(windowsSignatureProblem({ ...azureValid, TimeStamperSubject: '' }, valid.CommonName, { mode: 'azure' }))
        .toContain('timestamp')
    })
  })

  it('emits the signer certificate EKU OID list alongside the existing Authenticode fields', () => {
    const command = windowsSignatureCommand('Metis-Setup.exe')
    expect(command).toContain("$ext.Oid.Value -eq '2.5.29.37'")
    expect(command).toContain('EkuOids=$ekuOids')
  })
})
