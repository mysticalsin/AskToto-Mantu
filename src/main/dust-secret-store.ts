import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { WINDOWS_POWERSHELL } from './win-security'

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

/** Service the Dust CLI (keytar) stores under. */
export const DUST_KEYCHAIN_SERVICE = 'dust-cli'

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

async function readMac(account: string, service: string): Promise<DustSecretRead> {
  try {
    const { stdout } = await exec('security', [
      'find-generic-password',
      '-s',
      service,
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

/**
 * Spawn spec for the Credential-Manager read. Exported so a unit test can assert the command without a
 * Windows host. The command is the pinned absolute System32 path, never a bare `powershell.exe`: Windows'
 * CreateProcess search order consults the current working directory before PATH, so a bare name lets an
 * attacker-planted binary in an attacker-writable cwd read the user's stored OAuth token instead (see
 * win-security.ts).
 */
export function winCredReadSpawnSpec(target: string): { command: string; args: string[] } {
  // -EncodedCommand takes base64 of the UTF-16LE script — sidesteps every cmd/PowerShell quoting hazard.
  const encoded = Buffer.from(winCredReadScript(target), 'utf16le').toString('base64')
  return {
    command: WINDOWS_POWERSHELL,
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]
  }
}

async function readWin(account: string, service: string): Promise<DustSecretRead> {
  const { command, args } = winCredReadSpawnSpec(`${service}/${account}`)
  try {
    const { stdout } = await exec(command, args, { windowsHide: true, timeout: 15_000 })
    return { value: stdout.trim() || null, accessDenied: false }
  } catch {
    // Exit 2 = credential not present; any other failure → treat as no session (fall back to API key).
    return { value: null, accessDenied: false }
  }
}

async function readLinux(account: string, service: string): Promise<DustSecretRead> {
  try {
    const { stdout } = await exec(
      'secret-tool',
      ['lookup', 'service', service, 'account', account],
      { timeout: 15_000 }
    )
    return { value: stdout.trim() || null, accessDenied: false }
  } catch {
    return { value: null, accessDenied: false }
  }
}

/** Read one field of the Dust CLI session (access_token / workspace_sid / region) from the OS store. */
export async function readDustSecret(
  account: string,
  service: string = DUST_KEYCHAIN_SERVICE
): Promise<DustSecretRead> {
  switch (process.platform) {
    case 'darwin':
      return readMac(account, service)
    case 'win32':
      return readWin(account, service)
    default:
      return readLinux(account, service)
  }
}

export type DustSessionSecrets = {
  access_token: DustSecretRead
  workspace_sid: DustSecretRead
  region: DustSecretRead
  /** OS children that can show a password / UAC / Keychain dialog. One Connect = one spawn. */
  privilegeSpawns: number
}

const SESSION_ACCOUNTS = ['access_token', 'workspace_sid', 'region'] as const

/**
 * JXA: one SecItemCopyMatching for service=dust-cli (kSecMatchLimitAll).
 * One osascript process = one Keychain authorization, not three find-generic-password dialogs.
 */
export function macDustSessionJxa(service: string): string {
  // service is a fixed literal from DUST_KEYCHAIN_SERVICE — never user text.
  return [
    'ObjC.import("Security");',
    'ObjC.import("Foundation");',
    'function ns(s){return $.NSString.alloc.initWithUTF8String(s)}',
    'var q=$.NSMutableDictionary.alloc.init;',
    `q.setObjectForKey(ns(${JSON.stringify(service)}), $.kSecAttrService);`,
    'q.setObjectForKey($.kSecClassGenericPassword, $.kSecClass);',
    'q.setObjectForKey($.kSecMatchLimitAll, $.kSecMatchLimit);',
    'q.setObjectForKey($.kCFBooleanTrue, $.kSecReturnAttributes);',
    'q.setObjectForKey($.kCFBooleanTrue, $.kSecReturnData);',
    'var out=Ref();',
    'var st=$.SecItemCopyMatching(q, out);',
    'var acc={access_token:"",workspace_sid:"",region:""};',
    'var denied=false;',
    'if(st===-128||st===-25293||st===-25308){denied=true}',
    'else if(st===0){',
    '  var items=ObjC.deepUnwrap(out[0])||[];',
    '  if(!Array.isArray(items)) items=[items];',
    '  for(var i=0;i<items.length;i++){',
    '    var it=items[i];',
    '    var a=it.acct||it.Account||"";',
    '    var raw=it.v_Data||it.Value||"";',
    '    if(acc.hasOwnProperty(a)) acc[a]=raw;',
    '  }',
    '}',
    'var result={access_token:acc.access_token,workspace_sid:acc.workspace_sid,region:acc.region,accessDenied:denied};',
    'console.log(JSON.stringify(result));'
  ].join('')
}

/** One osascript spawn — never three `security` processes. */
export function macDustSessionSpawnSpec(service: string = DUST_KEYCHAIN_SERVICE): {
  command: string
  args: string[]
} {
  return {
    command: '/usr/bin/osascript',
    args: ['-l', 'JavaScript', '-e', macDustSessionJxa(service)]
  }
}

/**
 * One Credential Manager process that CredReads all three dust-cli targets.
 * Three separate powershell/CredRead spawns is the Windows form of the triple-prompt bug.
 */
export function winCredReadSessionScript(service: string = DUST_KEYCHAIN_SERVICE): string {
  const targets = SESSION_ACCOUNTS.map((a) => `${service}/${a}`)
  return [
    "$ErrorActionPreference='Stop'",
    'Add-Type @"',
    'using System;using System.Runtime.InteropServices;',
    'public class MetisCred {',
    '  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]',
    '  public static extern bool CredReadW(string t,int y,int f,out IntPtr c);',
    '  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr p);',
    '  [StructLayout(LayoutKind.Sequential)] public struct CREDENTIAL {',
    '    public int Flags;public int Type;public IntPtr TargetName;public IntPtr Comment;',
    '    public long LastWritten;public int CredentialBlobSize;public IntPtr CredentialBlob;',
    '    public int Persist;public int AttributeCount;public IntPtr Attributes;',
    '    public IntPtr TargetAlias;public IntPtr UserName; } }',
    '"@',
    'function Read-MetisCred([string]$t){',
    '  $p=[IntPtr]::Zero',
    '  if(-not [MetisCred]::CredReadW($t,1,0,[ref]$p)){ return $null }',
    '  try {',
    '    $c=[Runtime.InteropServices.Marshal]::PtrToStructure($p,[type][MetisCred+CREDENTIAL])',
    '    if($c.CredentialBlobSize -le 0){ return "" }',
    '    $b=New-Object byte[] $c.CredentialBlobSize',
    '    [Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob,$b,0,$c.CredentialBlobSize)',
    '    return [Text.Encoding]::UTF8.GetString($b)',
    '  } finally { [MetisCred]::CredFree($p) }',
    '}',
    `$tok=Read-MetisCred('${targets[0]}')`,
    `$ws=Read-MetisCred('${targets[1]}')`,
    `$reg=Read-MetisCred('${targets[2]}')`,
    // A missing cred is JSON null, not the string "null" — the reader treats "" as empty.
    '$o=[ordered]@{access_token=$tok;workspace_sid=$ws;region=$reg}',
    '($o | ConvertTo-Json -Compress)'
  ].join('\n')
}

export function winCredReadSessionSpawnSpec(service: string = DUST_KEYCHAIN_SERVICE): {
  command: string
  args: string[]
} {
  const encoded = Buffer.from(winCredReadSessionScript(service), 'utf16le').toString('base64')
  return {
    command: WINDOWS_POWERSHELL,
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]
  }
}

function emptySession(accessDenied: boolean, privilegeSpawns: number): DustSessionSecrets {
  const miss: DustSecretRead = { value: null, accessDenied }
  return {
    access_token: miss,
    workspace_sid: miss,
    region: { value: null, accessDenied },
    privilegeSpawns
  }
}

function parseSessionJson(raw: string, accessDenied: boolean, privilegeSpawns: number): DustSessionSecrets {
  try {
    const parsed = JSON.parse(raw) as {
      access_token?: unknown
      workspace_sid?: unknown
      region?: unknown
      accessDenied?: unknown
    }
    const denied = accessDenied || parsed.accessDenied === true
    const field = (v: unknown): DustSecretRead => ({
      value: typeof v === 'string' && v.trim() ? v.trim() : null,
      accessDenied: denied
    })
    return {
      access_token: field(parsed.access_token),
      workspace_sid: field(parsed.workspace_sid),
      region: field(parsed.region),
      privilegeSpawns
    }
  } catch {
    return emptySession(accessDenied, privilegeSpawns)
  }
}

/**
 * Read access_token + workspace_sid + region in ONE privileged spawn.
 * Mac: one osascript / Security.framework query. Windows: one CredRead powershell.
 * Sequential per-account reads are the triple password bug — do not call this in a loop.
 */
export async function readDustSessionSecrets(
  service: string = DUST_KEYCHAIN_SERVICE
): Promise<DustSessionSecrets> {
  if (process.platform === 'darwin') {
    const spec = macDustSessionSpawnSpec(service)
    try {
      const { stdout } = await exec(spec.command, spec.args, { timeout: 20_000 })
      return parseSessionJson(stdout, false, 1)
    } catch (error) {
      return emptySession(macAccessDenied(error), 1)
    }
  }
  if (process.platform === 'win32') {
    const spec = winCredReadSessionSpawnSpec(service)
    try {
      const { stdout } = await exec(spec.command, spec.args, { windowsHide: true, timeout: 15_000 })
      // CredRead never prompts — still one process, counted so Windows Quality can assert "not three".
      return parseSessionJson(stdout, false, 1)
    } catch {
      return emptySession(false, 1)
    }
  }
  // Linux: one secret-tool per account, but those never prompt. Privilege count stays 1 (one Connect).
  const [token, workspace, region] = await Promise.all(
    SESSION_ACCOUNTS.map((account) => readLinux(account, service))
  )
  return { access_token: token, workspace_sid: workspace, region, privilegeSpawns: 1 }
}
