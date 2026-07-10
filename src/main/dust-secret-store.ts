import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/**
 * Read the Dust CLI's OAuth session out of the OS secret store, cross-platform.
 *
 * The Dust CLI (`@dust-tt/dust-cli`) persists its session via keytar under service `dust-cli`, accounts
 * `access_token` / `workspace_sid` / `region` (also `refresh_token`, which we don't need — `dust status`
 * refreshes for us). keytar uses a different native store per OS, so the read is per-OS but always a
 * native-module-free shell-out (exactly like the original macOS-only `security` path):
 *   - macOS   → Keychain generic password           → `security find-generic-password`
 *   - Windows → Credential Manager (CRED_TYPE_GENERIC, target "dust-cli/<account>") → PowerShell CredRead
 *   - Linux   → libsecret (Secret Service)           → `secret-tool lookup`
 * Reading the CURRENT user's own credential never prompts on Windows/Linux; macOS shows a one-time
 * "allow access" dialog whose denial we surface as accessDenied so the UI can ask for permission.
 */

/** Service the Dust CLI (keytar) stores under. Overridable only so integration tests can point at a
 *  throwaway entry instead of the user's real session. */
export const DUST_KEYCHAIN_SERVICE = process.env.DUST_CLI_KEYCHAIN_SERVICE || 'dust-cli'

export interface DustSecretRead {
  value: string | null
  /** macOS only: the OS blocked the read (user must grant Keychain access). Never set on Windows/Linux. */
  accessDenied: boolean
}

/** macOS `security` read denied (user hasn't granted the one-time Keychain access). */
function macAccessDenied(error: unknown): boolean {
  const e = error as { stderr?: string; message?: string }
  return /user interaction is not allowed|authorization.*denied|errsec(authfailed|interactionnotallowed)|\b-2529[13]\b/i.test(
    `${e?.stderr || ''}\n${e?.message || ''}`
  )
}

async function readMac(account: string): Promise<DustSecretRead> {
  try {
    const { stdout } = await exec('security', [
      'find-generic-password',
      '-s',
      DUST_KEYCHAIN_SERVICE,
      '-a',
      account,
      '-w'
    ])
    return { value: stdout.trim() || null, accessDenied: false }
  } catch (error) {
    return { value: null, accessDenied: macAccessDenied(error) }
  }
}

/**
 * PowerShell that reads one Credential-Manager generic credential's secret blob via a CredRead P/Invoke
 * and writes it to stdout as UTF-8. `cmdkey`/`vaultcmd` can only LIST names, never return the blob, so
 * this tiny advapi32 wrapper is the only native-module-free way to read it. `target` is always a fixed
 * literal ("dust-cli/<account>"), so no untrusted interpolation. Exit 2 = credential not present.
 */
export function winCredReadScript(target: string): string {
  return [
    "$ErrorActionPreference='Stop'",
    'Add-Type @"',
    'using System;using System.Runtime.InteropServices;',
    'public class MetisCred {',
    '  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]',
    '  public static extern bool CredReadW(string t,int y,int f,out IntPtr c);',
    '  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr c);',
    '  [StructLayout(LayoutKind.Sequential)] public struct CREDENTIAL {',
    '    public int Flags;public int Type;public IntPtr TargetName;public IntPtr Comment;',
    '    public long LastWritten;public int CredentialBlobSize;public IntPtr CredentialBlob;',
    '    public int Persist;public int AttributeCount;public IntPtr Attributes;',
    '    public IntPtr TargetAlias;public IntPtr UserName; } }',
    '"@',
    '$p=[IntPtr]::Zero',
    `if(-not [MetisCred]::CredReadW('${target}',1,0,[ref]$p)){ exit 2 }`,
    'try {',
    '  $c=[Runtime.InteropServices.Marshal]::PtrToStructure($p,[type][MetisCred+CREDENTIAL])',
    '  if($c.CredentialBlobSize -gt 0){',
    '    $b=New-Object byte[] $c.CredentialBlobSize',
    '    [Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob,$b,0,$c.CredentialBlobSize)',
    '    [Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))',
    '  }',
    '} finally { [MetisCred]::CredFree($p) }'
  ].join('\n')
}

async function readWin(account: string): Promise<DustSecretRead> {
  const script = winCredReadScript(`${DUST_KEYCHAIN_SERVICE}/${account}`)
  // -EncodedCommand takes base64 of the UTF-16LE script — sidesteps every cmd/PowerShell quoting hazard.
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  try {
    const { stdout } = await exec(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 15_000 }
    )
    return { value: stdout.trim() || null, accessDenied: false }
  } catch {
    // Exit 2 = credential not present; any other failure → treat as no session (fall back to API key).
    return { value: null, accessDenied: false }
  }
}

async function readLinux(account: string): Promise<DustSecretRead> {
  try {
    const { stdout } = await exec(
      'secret-tool',
      ['lookup', 'service', DUST_KEYCHAIN_SERVICE, 'account', account],
      { timeout: 15_000 }
    )
    return { value: stdout.trim() || null, accessDenied: false }
  } catch {
    return { value: null, accessDenied: false }
  }
}

/** Read one field of the Dust CLI session (access_token / workspace_sid / region) from the OS store. */
export async function readDustSecret(account: string): Promise<DustSecretRead> {
  switch (process.platform) {
    case 'darwin':
      return readMac(account)
    case 'win32':
      return readWin(account)
    default:
      return readLinux(account)
  }
}
