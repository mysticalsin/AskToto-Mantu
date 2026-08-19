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
import { closeSync, fstatSync, openSync, readFileSync, statSync, type Stats } from 'node:fs'
import { join } from 'node:path'
// Via logger.ts, never `electron-log` directly — see the note on the same import in updater.ts.
import { mainLog as log } from './logger'

// Invoke Windows system tools by ABSOLUTE %SystemRoot%\System32 path, never bare name. Windows'
// CreateProcess search order includes the current working directory, so a bare `powershell`/`icacls`
// could execute an attacker-planted binary if AskToto is ever launched from an attacker-writable cwd —
// and here that would subvert the very ACL check that decides whether to trust machine policy. An
// absolute path removes cwd/PATH from the resolution entirely.
const SYS32 = join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32')
/** The ONE name any main-process module may use for powershell. Exported (rather than each caller
 *  re-deriving or, worse, spelling a bare 'powershell.exe') so the invariant above holds repo-wide:
 *  foreground-watcher.ts and dust-secret-store.ts spawn this exact pinned binary. */
export const WINDOWS_POWERSHELL = join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
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

/**
 * Exported ONLY so a test can assert the probe resolves a real owner SID (MQA-008). Every live ACL test
 * before it asserted the reject direction, which a probe that returns `owner: ''` for every file passes
 * trivially — the trust decision failed closed and looked correct while silently disabling all Windows
 * machine policy. Nothing in the app should call this directly; use isAdminManagedTrusted.
 */
export function readAclForTest(path: string): AclProbe | null {
  return readAcl(path)
}

function readAcl(path: string): AclProbe | null {
  const ps = `
$ErrorActionPreference='Stop'
try {
  $a = Get-Acl -LiteralPath ${JSON.stringify(path)}
  function SidOf($ref){ try { return $ref.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { return $ref.Value } }
  # MQA-008: the owner MUST come from GetOwner(), not from the .Owner property. FileSecurity.Owner is a
  # System.String (e.g. "BUILTIN\\Administrators"), not an IdentityReference — so SidOf() threw on
  # .Translate(), fell back to .Value on a String (null), and every managed-config file on win32 was
  # judged untrusted. Silent effect: requireAuth, allowedProviders, lockedKeys and disableAutoUpdate
  # were NEVER enforced from a machine policy, while IT saw only a single "not admin-owned" warning.
  # ACE identities are genuine NTAccount objects, so SidOf stays correct for them.
  $ownerSid = ''
  try { $ownerSid = $a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value } catch {
    try { $ownerSid = (New-Object System.Security.Principal.NTAccount($a.Owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $ownerSid = '' }
  }
  $out = [ordered]@{ owner = $ownerSid; aces = @() }
  foreach($ace in $a.Access){
    $out.aces += [ordered]@{ sid = (SidOf $ace.IdentityReference); rights = [int]$ace.FileSystemRights.value__; type = $ace.AccessControlType.ToString() }
  }
  $out | ConvertTo-Json -Compress -Depth 5
} catch { '' }`
  try {
    const out = execFileSync(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', ps], {
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

// The ACL verdict is memoized ONLY under a key its subject cannot forge, and ONLY for seconds.
//
// An earlier version cached it keyed on `${mtimeMs}:${size}` alone (content metadata) on the theory that
// "a mid-session ACL swap would itself require the very privilege this check denies." That was wrong
// twice over: icacls/Set-Acl changes a DACL without touching content, so the key is blind to the exact
// thing this module exists to check; and BOTH halves of that key are chosen by whoever creates the file,
// so a standard user — who already has create/delete on `%ProgramData%\Métis`, the premise of this whole
// module — could delete an admin-owned policy and drop in a forged one carrying the same mtime and size
// to inherit its trusted verdict. It also never expired.
//
// Removing the cache outright was not sustainable either (MQA-028 / MQA-034): each probe is a SYNCHRONOUS
// execFileSync(powershell) measured at 0.5-1.9 s on a managed install, requireAuth() alone fires three of
// them before any privileged IPC handler body runs, and store.ts's allowlist read hangs off a 6 s
// background tick — seconds of frozen main process per user action, on every IT-managed Windows install.
//
// So the memo is keyed on the file's KERNEL-assigned identity (dev + inode) as well as its content
// metadata, and expires after ACL_VERDICT_TTL_MS:
//   • dev+ino are handed out by the filesystem, never chosen by the file's creator — a delete-and-replace
//     (the only swap a non-elevated user can perform, since editing a DACL in place needs WRITE_DAC on a
//     file they do not own) lands a different inode and re-probes at once, forged mtime/size or not.
//   • the TTL bounds the one case that key can't see — a PRIVILEGED in-place DACL edit, i.e. IT running
//     icacls to harden or loosen the policy — to a few seconds of staleness instead of forever.
const ACL_VERDICT_TTL_MS = 5_000

type AclMemo = { path: string; dev: number; ino: number; mtimeMs: number; size: number; trusted: boolean; at: number }
// One slot: production probes exactly one path (adminManagedConfigPath()); a second path just evicts it.
let aclMemo: AclMemo | null = null

/** Trust verdict for the file `st` describes. `st` must be the caller's OWN stat/fstat of the file it is
 *  about to act on, so a memo can never be applied to a different file than the one that was probed. */
function aclTrusted(path: string, st: Stats): boolean {
  const now = Date.now()
  if (
    aclMemo &&
    aclMemo.path === path &&
    aclMemo.dev === st.dev &&
    aclMemo.ino === st.ino &&
    aclMemo.mtimeMs === st.mtimeMs &&
    aclMemo.size === st.size &&
    // A clock set backwards must not extend a memo indefinitely — treat any negative age as expired.
    now - aclMemo.at >= 0 &&
    now - aclMemo.at < ACL_VERDICT_TTL_MS
  ) {
    return aclMemo.trusted
  }
  const acl = readAcl(path)
  // A failed probe memoizes its fail-closed `false` too: otherwise a machine where powershell is missing
  // or wedged pays readAcl's full 8 s timeout on every privileged IPC call.
  const trusted = acl ? evaluateAclTrust(acl) : false
  aclMemo = { path, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, size: st.size, trusted, at: now }
  return trusted
}

let warnedUntrusted = false

function warnUntrusted(path: string): void {
  if (warnedUntrusted) return
  warnedUntrusted = true
  log.warn(
    `[win-security] ignoring machine managed-config at ${path}: not admin-owned or writable by ` +
      `non-privileged users. Deploy it via an elevated installer/GPO so it is owned by ` +
      `SYSTEM/Administrators with no Users-write ACE.`
  )
}

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
 *
 * NOTE: this function alone is NOT enough to safely read the file's content — a caller that does
 * `if (isAdminManagedTrusted(p)) readFileSync(p)` reopens a TOCTOU between this check and that read
 * (the file can be swapped in between). Use readTrustedAdminManaged() below for the actual content;
 * this export remains for the boolean question and is what the unit tests exercise directly.
 */
export function isAdminManagedTrusted(path: string = adminManagedConfigPath()): boolean {
  if (process.platform !== 'win32') return true
  let st: Stats
  try {
    st = statSync(path)
    if (!st.isFile()) return false
  } catch {
    return false // absent → no policy to honor; returning true here reopens the stat→read race
  }

  const trusted = aclTrusted(path, st)
  if (!trusted) warnUntrusted(path)
  return trusted
}

/** The machine managed-config path, or null on win32 when it is not admin-trusted (see above).
 *  Path-only — safe for cache keys/mtime/display, but reading content by this path afterward reopens
 *  the check→read TOCTOU (see readTrustedAdminManaged). No current caller does that; content readers
 *  all use readTrustedAdminManaged() instead. */
export function trustedAdminManagedPath(): string | null {
  const p = adminManagedConfigPath()
  return isAdminManagedTrusted(p) ? p : null
}

/**
 * Read the machine managed-config file's content IFF it is admin-trusted — closing the TOCTOU that
 * `isAdminManagedTrusted(p) ? readFileSync(p) : ...` leaves open: a standard user with create/delete
 * rights on the ProgramData dir can swap a forged file in between that check and that read, so the
 * content actually read never matches what was ACL-verified.
 *
 * Fix: open the file ONCE and keep the fd for both the trust decision and the read.
 * - The fd is opened before anything else, so its content is fixed at open time regardless of what
 *   later happens at that path.
 * - `Get-Acl` only takes a path (no Win32 API here operates on a Node fd without a native addon), so
 *   after the ACL check we re-stat the path and require it still resolve to the SAME file (matching
 *   device+inode) our fd holds. If an attacker swapped the path mid-ACL-check, the identity no longer
 *   matches and the read is refused — the trust decision and the fd's content are provably about the
 *   same on-disk file, not just "some file that was at this path at some point".
 * - The content is then read from the held fd, never re-opened by path, so nothing can be substituted
 *   after the identity check passes.
 *
 * Non-win32: the parent dir is root-owned, so a plain readFileSync is already safe (matches
 * isAdminManagedTrusted's platform gate). Returns null when absent, unreadable, untrusted, or the
 * path was swapped mid-check.
 */
export function readTrustedAdminManaged(path: string = adminManagedConfigPath()): string | null {
  if (process.platform !== 'win32') {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  }

  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return null // absent/unreadable → no policy to honor
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) return null

    const trusted = aclTrusted(path, st)
    if (!trusted) {
      warnUntrusted(path)
      return null
    }

    // Defend the Get-Acl-by-path step above: confirm the path still resolves to the exact file our fd
    // holds before trusting its content. A swap during the ACL check (this file's window is now the
    // ACL-check's PowerShell round-trip, not "until the caller gets around to reading it") would change
    // dev/ino here. Kept unconditional even when aclTrusted() answered from its memo — that path never
    // touches the name at all, so this is then a free re-assertion of the identity the memo was keyed on.
    let st2: ReturnType<typeof statSync>
    try {
      st2 = statSync(path)
    } catch {
      return null
    }
    if (st2.dev !== st.dev || st2.ino !== st.ino) return null

    return readFileSync(fd, 'utf8')
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
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
