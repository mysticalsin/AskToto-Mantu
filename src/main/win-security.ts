// Windows-specific trust + confidentiality primitives.
//
// Two platform gaps this module closes:
//
//  1. Machine managed-config trust. On macOS/Linux the machine policy dir
//     (`/Library/Application Support/Métis`, `/etc/asktoto`) is root-owned, so a standard user
//     cannot forge it. On Windows the natural location `%ProgramData%\Métis` inherits ProgramData's
//     default ACL, which grants `BUILTIN\Users` write — so ANY standard user (no elevation) can
//     pre-create `%ProgramData%\Métis\managed-config.json` and have it consumed as authoritative IT
//     policy (escrow pubkey, tenant lock, provider allowlist, forced-auth). `isAdminManagedTrusted`
//     rejects the file unless it is admin/SYSTEM-owned AND grants no write to non-privileged principals.
//
//  2. `writeFileSync(..., { mode: 0o600 })` is a NO-OP on Windows (Node ignores POSIX mode bits; the
//     file inherits its parent dir's ACL). `lockPathToCurrentUserWin32` applies a real owner-only DACL
//     via icacls for cleartext material that must not widen beyond the current user.
//
// Both shell out to built-in Windows tools (powershell / icacls); everything is a no-op off win32.

import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import log from 'electron-log'

// Invoke Windows system tools by ABSOLUTE %SystemRoot%\System32 path, never bare name. Windows'
// CreateProcess search order includes the current working directory, so a bare `powershell`/`icacls`
// could execute an attacker-planted binary if AskToto is ever launched from an attacker-writable cwd —
// and here that would subvert the very ACL check that decides whether to trust machine policy. An
// absolute path removes cwd/PATH from the resolution entirely.
const SYS32 = join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32')
const POWERSHELL = join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const ICACLS = join(SYS32, 'icacls.exe')

/** Single source of truth for the machine-wide org-policy managed-config path (was duplicated across
 *  store.ts / auth.ts / transcripts.ts). */
export function adminManagedConfigPath(): string {
  if (process.platform === 'darwin') return '/Library/Application Support/Métis/managed-config.json'
  if (process.platform === 'win32')
    return join(process.env.ProgramData || 'C:\\ProgramData', 'Métis', 'managed-config.json')
  return '/etc/asktoto/managed-config.json'
}

// Well-known SIDs that legitimately author a machine policy (deployed by MSI/GPO/Intune, which run as
// SYSTEM or TrustedInstaller, or by a hardened Administrators-owned dir).
const ADMIN_OWNER_SIDS = new Set([
  'S-1-5-18', // NT AUTHORITY\SYSTEM
  'S-1-5-19', // LOCAL SERVICE
  'S-1-5-20', // NETWORK SERVICE
  'S-1-5-32-544', // BUILTIN\Administrators
  // TrustedInstaller
  'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
])

// SIDs that may legitimately hold a WRITE ACE on an admin-authored policy file: the admin/SYSTEM owner
// set, plus CREATOR OWNER / OWNER RIGHTS (these resolve to the file's owner at evaluation time, and the
// owner is separately pinned to an admin SID). This is a WHITELIST — any Allow-write ACE held by a SID
// outside it is untrusted. A whitelist (vs the previous group blacklist) also rejects the narrow case of
// an admin-owned file that grants write to a specific standard-user account (RID >= 1000), which a
// blacklist of well-known groups would have missed.
const ADMIN_WRITE_SIDS = new Set([
  ...ADMIN_OWNER_SIDS,
  'S-1-3-0', // CREATOR OWNER (resolves to the file owner — already pinned admin by the owner check)
  'S-1-3-4' // OWNER RIGHTS
])

/** True when this SID is allowed to hold a write ACE on an admin-authored policy file. */
function isAdminWriteSid(sid: string): boolean {
  return ADMIN_WRITE_SIDS.has(sid)
}

// FileSystemRights bits that let a principal modify/replace/relabel the file (write-data, append,
// write-EA/attrs, delete, write-DAC, write-owner, generic-write, generic-all).
const WRITE_MASK = 0x2 | 0x4 | 0x10 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000

export type AclProbe = { owner: string; aces: { sid: string; rights: number; type: string }[] }

/** Pure trust decision over a probed ACL: the file is admin-authored iff it is owned by a well-known
 *  admin/SYSTEM principal AND no broad non-admin principal holds a write ACE. Exported for unit tests. */
export function evaluateAclTrust(acl: AclProbe): boolean {
  const ownerOk = ADMIN_OWNER_SIDS.has(acl.owner)
  // Whitelist: reject if ANY Allow-write ACE is held by a principal outside the admin-write set.
  const hasUntrustedWrite = acl.aces.some(
    (a) => a.type === 'Allow' && (a.rights & WRITE_MASK) !== 0 && !isAdminWriteSid(a.sid)
  )
  return ownerOk && !hasUntrustedWrite
}

function readAcl(path: string): AclProbe | null {
  const ps = `
$ErrorActionPreference='Stop'
try {
  $a = Get-Acl -LiteralPath ${JSON.stringify(path)}
  function SidOf($ref){ try { return $ref.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { return $ref.Value } }
  $out = [ordered]@{ owner = (SidOf $a.Owner); aces = @() }
  foreach($ace in $a.Access){
    $out.aces += [ordered]@{ sid = (SidOf $ace.IdentityReference); rights = [int]$ace.FileSystemRights.value__; type = $ace.AccessControlType.ToString() }
  }
  $out | ConvertTo-Json -Compress -Depth 5
} catch { '' }`
  try {
    const out = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 8000
    }).trim()
    if (!out) return null
    const parsed = JSON.parse(out)
    // ConvertTo-Json emits a bare object for a single ACE; normalize to an array.
    const aces = Array.isArray(parsed.aces) ? parsed.aces : parsed.aces ? [parsed.aces] : []
    return { owner: String(parsed.owner || ''), aces }
  } catch {
    return null
  }
}

// The ACL verdict is deliberately NOT cached. An earlier version cached it keyed on `${mtimeMs}:${size}`
// (content metadata) on the theory that "a mid-session ACL swap would itself require the very privilege
// this check denies." That's false: icacls/Set-Acl changes a file's DACL without touching its content,
// so mtime+size stays constant across an ACL change — the cache key is blind to the exact thing this
// function exists to check. A file could be hardened (or loosened) via ACL alone and this function would
// keep returning the stale verdict from before the change until the content also happened to change.
// Since the ACL check IS the security gate, and callers do a separate readFileSync for content after
// calling this, the verdict must be fresh on every call. Perf is fine: callers already sit behind
// getSettings()'s own mtime-keyed cache (store.ts), so this doesn't run on every settings read.
let warnedUntrusted = false

/**
 * Is the machine managed-config file safe to honor as ADMIN-authored policy?
 * - Non-win32: yes — the parent dir is root-owned, the OS already enforces it.
 * - win32: yes only if the file is owned by SYSTEM/Administrators/TrustedInstaller AND no broad
 *   non-admin principal (Users, Authenticated Users, Everyone, Domain Users…) has a write ACE.
 *   A file planted by a standard user fails BOTH tests (they own it; it inherits Users:Write).
 * Fails to "untrusted" both when the file is absent AND when the ACL cannot be read, so an
 * unreadable/oddly-permissioned policy is never silently honored. Absent must NOT report trusted:
 * that opened a stat→read TOCTOU where a standard user create/delete loop on the ProgramData path
 * could win the race and get a forged policy honored for that read (and cached by mtime upstream).
 * Legitimate behavior is identical — every reader already treats an absent file as no-policy.
 */
export function isAdminManagedTrusted(path: string = adminManagedConfigPath()): boolean {
  if (process.platform !== 'win32') return true
  try {
    const st = statSync(path)
    if (!st.isFile()) return false
  } catch {
    return false // absent → no policy to honor; returning true here reopens the stat→read race
  }

  const acl = readAcl(path)
  const trusted = acl ? evaluateAclTrust(acl) : false
  if (!trusted && !warnedUntrusted) {
    warnedUntrusted = true
    log.warn(
      `[win-security] ignoring machine managed-config at ${path}: not admin-owned or writable by ` +
        `non-privileged users. Deploy it via an elevated installer/GPO so it is owned by ` +
        `SYSTEM/Administrators with no Users-write ACE.`
    )
  }
  return trusted
}

/** The machine managed-config path, or null on win32 when it is not admin-trusted (see above). Callers
 *  use this instead of the raw path so a forged ProgramData policy is never read. */
export function trustedAdminManagedPath(): string | null {
  const p = adminManagedConfigPath()
  return isAdminManagedTrusted(p) ? p : null
}

/** Apply an owner-only DACL (current user + SYSTEM, inheritance removed) to a file on win32, where
 *  `{ mode: 0o600 }` is ignored. No-op off win32 and best-effort (never throws). */
export function lockPathToCurrentUserWin32(path: string): void {
  if (process.platform !== 'win32') return
  try {
    // /inheritance:r drops inherited ACEs; grant only the current user + SYSTEM full control.
    execFileSync(ICACLS, [path, '/inheritance:r', '/grant:r', '*S-1-5-18:(F)', `${currentUserGrant()}:(F)`], {
      stdio: 'ignore',
      timeout: 8000
    })
  } catch {
    /* best-effort: the file already lives under the per-user %TEMP%/userData ACL */
  }
}

function currentUserGrant(): string {
  // USERDOMAIN\USERNAME is what icacls expects; fall back to bare USERNAME.
  const u = process.env.USERNAME || ''
  const d = process.env.USERDOMAIN || ''
  return d && u ? `${d}\\${u}` : u
}
