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

/** True when a write ACE for this SID means a non-privileged principal could tamper with the file. */
function isNonAdminWriteSid(sid: string): boolean {
  if (sid === 'S-1-1-0') return true // Everyone
  if (sid === 'S-1-5-11') return true // Authenticated Users
  if (sid === 'S-1-5-4') return true // Interactive
  if (sid === 'S-1-5-7') return true // Anonymous
  if (sid === 'S-1-5-32-545') return true // BUILTIN\Users
  if (sid === 'S-1-5-32-546') return true // Guests
  if (/^S-1-5-21-\d+-\d+-\d+-(513|514|515|545)$/.test(sid)) return true // Domain Users/Guests/Computers, local Users
  return false
}

// FileSystemRights bits that let a principal modify/replace/relabel the file (write-data, append,
// write-EA/attrs, delete, write-DAC, write-owner, generic-write, generic-all).
const WRITE_MASK = 0x2 | 0x4 | 0x10 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000

export type AclProbe = { owner: string; aces: { sid: string; rights: number; type: string }[] }

/** Pure trust decision over a probed ACL: the file is admin-authored iff it is owned by a well-known
 *  admin/SYSTEM principal AND no broad non-admin principal holds a write ACE. Exported for unit tests. */
export function evaluateAclTrust(acl: AclProbe): boolean {
  const ownerOk = ADMIN_OWNER_SIDS.has(acl.owner)
  const hasNonAdminWrite = acl.aces.some(
    (a) => a.type === 'Allow' && (a.rights & WRITE_MASK) !== 0 && isNonAdminWriteSid(a.sid)
  )
  return ownerOk && !hasNonAdminWrite
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
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
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

// Cache the verdict per path, keyed on mtime+size so a legitimately-updated policy is re-checked but we
// don't spawn PowerShell on every settings read. A mid-session ACL swap by an attacker would itself
// require the very privilege this check denies, so caching the verdict is safe.
const trustCache = new Map<string, { key: string; trusted: boolean }>()
let warnedUntrusted = false

/**
 * Is the machine managed-config file safe to honor as ADMIN-authored policy?
 * - Non-win32: yes — the parent dir is root-owned, the OS already enforces it.
 * - win32: yes only if the file is owned by SYSTEM/Administrators/TrustedInstaller AND no broad
 *   non-admin principal (Users, Authenticated Users, Everyone, Domain Users…) has a write ACE.
 *   A file planted by a standard user fails BOTH tests (they own it; it inherits Users:Write).
 * Fails CLOSED to "trusted" only when the file is absent (nothing to read); fails OPEN to "untrusted"
 * when the ACL cannot be read, so an unreadable/oddly-permissioned policy is never silently honored.
 */
export function isAdminManagedTrusted(path: string = adminManagedConfigPath()): boolean {
  if (process.platform !== 'win32') return true
  let key: string
  try {
    const st = statSync(path)
    if (!st.isFile()) return false
    key = `${st.mtimeMs}:${st.size}`
  } catch {
    return true // absent → readers get null anyway; nothing to distrust
  }
  const cached = trustCache.get(path)
  if (cached && cached.key === key) return cached.trusted

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
  trustCache.set(path, { key, trusted })
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
    execFileSync('icacls', [path, '/inheritance:r', '/grant:r', '*S-1-5-18:(F)', `${currentUserGrant()}:(F)`], {
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
