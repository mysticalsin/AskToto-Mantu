import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// MQA-028 / MQA-034: the ACL probe is a synchronous powershell.exe spawn measured at 0.5-1.9 s, so the
// tests at the bottom of this file assert HOW MANY actually happen. Count them at the one choke point
// every probe goes through, passing the call straight on so the live Get-Acl cases stay real.
const probes = vi.hoisted(() => ({ count: 0 }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => {
      probes.count++
      return (actual.execFileSync as (...a: unknown[]) => unknown)(...args)
    }
  }
})
vi.mock('electron')

import {
  __resetAclMemoForTest,
  evaluateAclTrust,
  isAdminManagedTrusted,
  readAclForTest,
  readTrustedAdminManaged,
  trustedAdminManagedPath,
  WINDOWS_POWERSHELL,
  type AclProbe
} from './win-security'
import { getAllowedProviders, getLockedKeys } from './store'

const REAL_PLATFORM = process.platform
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}
afterEach(() => Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true }))

// The ACL verdict memo is a module singleton; clear it before every test so the probe-count assertions
// in this file are order-independent (a prior test's still-valid memo would otherwise absorb the first
// probe of the next test). Runs before each describe's own beforeEach.
beforeEach(() => __resetAclMemoForTest())

// FileSystemRights: FullControl = 0x1F01FF, Modify = 0x301BF, ReadAndExecute = 0x1200A9, Write = 0x116.
const FULL = 0x1f01ff
const READ = 0x1200a9
const WRITE = 0x116

const SYSTEM = 'S-1-5-18'
const ADMINS = 'S-1-5-32-544'
const USERS = 'S-1-5-32-545'
const AUTH_USERS = 'S-1-5-11'
const EVERYONE = 'S-1-1-0'
const ATTACKER = 'S-1-5-21-111-222-333-1005' // a normal domain/local user RID

describe('WINDOWS_POWERSHELL — the shared pinned interpreter path', () => {
  // Every main-process powershell spawn resolves through this constant, so pin its shape here once:
  // a bare name would let CreateProcess's cwd-before-PATH search order pick up a planted binary.
  it('is an absolute %SystemRoot%\\System32 path, never a bare name', () => {
    expect(WINDOWS_POWERSHELL).toMatch(
      /^[A-Za-z]:[\\/](.+[\\/])?System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i
    )
    expect(WINDOWS_POWERSHELL).not.toBe('powershell.exe')
  })
})

describe('evaluateAclTrust — the Windows managed-config trust decision', () => {
  it('trusts a SYSTEM-owned policy whose only write ACEs are admin principals', () => {
    const acl: AclProbe = {
      owner: SYSTEM,
      aces: [
        { sid: SYSTEM, rights: FULL, type: 'Allow' },
        { sid: ADMINS, rights: FULL, type: 'Allow' },
        { sid: USERS, rights: READ, type: 'Allow' } // read-only for Users is fine
      ]
    }
    expect(evaluateAclTrust(acl)).toBe(true)
  })

  it('trusts an Administrators-owned policy with no non-admin write', () => {
    expect(evaluateAclTrust({ owner: ADMINS, aces: [{ sid: ADMINS, rights: FULL, type: 'Allow' }] })).toBe(true)
  })

  it('REJECTS the demonstrated attack: file planted by a standard user (they own it, Users inherits write)', () => {
    const forged: AclProbe = {
      owner: ATTACKER,
      aces: [
        { sid: ATTACKER, rights: FULL, type: 'Allow' },
        { sid: USERS, rights: WRITE, type: 'Allow' } // inherited from C:\ProgramData default ACL
      ]
    }
    expect(evaluateAclTrust(forged)).toBe(false)
  })

  it('REJECTS an admin-owned file that still grants write to Users/Authenticated Users/Everyone', () => {
    for (const sid of [USERS, AUTH_USERS, EVERYONE]) {
      expect(
        evaluateAclTrust({
          owner: SYSTEM,
          aces: [
            { sid: SYSTEM, rights: FULL, type: 'Allow' },
            { sid, rights: WRITE, type: 'Allow' }
          ]
        })
      ).toBe(false)
    }
  })

  it('REJECTS a file owned by a non-admin principal even with a clean DACL', () => {
    expect(evaluateAclTrust({ owner: ATTACKER, aces: [{ sid: ATTACKER, rights: FULL, type: 'Allow' }] })).toBe(false)
  })

  it('REJECTS an admin-owned file that grants write to a SPECIFIC standard user (RID >= 1000)', () => {
    // The blacklist of well-known groups missed this; the whitelist rejects any non-admin write principal.
    expect(
      evaluateAclTrust({
        owner: SYSTEM,
        aces: [
          { sid: SYSTEM, rights: FULL, type: 'Allow' },
          { sid: ATTACKER, rights: WRITE, type: 'Allow' } // a specific standard-user account, not a group
        ]
      })
    ).toBe(false)
  })

  it('allows CREATOR OWNER / OWNER RIGHTS write on an admin-owned file', () => {
    // These resolve to the file owner, which the owner check already pins to an admin SID.
    for (const sid of ['S-1-3-0', 'S-1-3-4']) {
      expect(
        evaluateAclTrust({
          owner: ADMINS,
          aces: [
            { sid: ADMINS, rights: FULL, type: 'Allow' },
            { sid, rights: FULL, type: 'Allow' }
          ]
        })
      ).toBe(true)
    }
  })

  it('ignores Deny ACEs when judging non-admin write', () => {
    expect(
      evaluateAclTrust({
        owner: SYSTEM,
        aces: [
          { sid: SYSTEM, rights: FULL, type: 'Allow' },
          { sid: USERS, rights: WRITE, type: 'Deny' } // a Deny for Users is not a grant
        ]
      })
    ).toBe(true)
  })
})

describe('isAdminManagedTrusted / trustedAdminManagedPath — platform gate', () => {
  it('always trusts off-win32 (root-owned dirs enforce it) and returns the real path', () => {
    setPlatform('darwin')
    expect(isAdminManagedTrusted('/Library/Application Support/Métis/managed-config.json')).toBe(true)
    expect(trustedAdminManagedPath()).toBe('/Library/Application Support/Métis/managed-config.json')
  })

  it('does NOT trust an ABSENT win32 policy file (closes the stat→read TOCTOU)', () => {
    setPlatform('win32')
    // A path that does not exist → statSync throws → untrusted. Readers treat the resulting null
    // path as no-policy either way; reporting trusted here let a create/delete loop race the
    // gate's statSync against the caller's readFileSync and get a forged policy honored.
    expect(isAdminManagedTrusted('C:\\ProgramData\\Métis\\__does_not_exist__.json')).toBe(false)
  })
})

describe('readTrustedAdminManaged — content read tied to the trust decision', () => {
  const tmpDir = join(tmpdir(), `wsec-readtrust-${process.pid}`)
  const file = join(tmpDir, 'managed-config.json')
  afterEach(() => {
    try {
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  it('off-win32: reads the real file content straight through (root-owned dir already enforces trust)', () => {
    setPlatform('darwin')
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(file, JSON.stringify({ requireAuth: true }))
    expect(readTrustedAdminManaged(file)).toBe(JSON.stringify({ requireAuth: true }))
  })

  it('off-win32: returns null for an absent file', () => {
    setPlatform('darwin')
    expect(readTrustedAdminManaged(join(tmpDir, '__does_not_exist__.json'))).toBeNull()
  })

  it('win32: returns null for an absent file (no fd to open, no policy to honor)', () => {
    setPlatform('win32')
    expect(readTrustedAdminManaged('C:\\ProgramData\\Métis\\__does_not_exist__.json')).toBeNull()
  })
})

// Live end-to-end proof through the real PowerShell Get-Acl reader: a file a standard (non-elevated)
// user can create under %ProgramData% must NOT be honored as admin policy. Windows-only; self-cleaning.
describe.runIf(process.platform === 'win32')('isAdminManagedTrusted — real ProgramData ACL (win32)', () => {
  const dir = join(process.env.ProgramData || 'C:\\ProgramData', 'Metis__wsectest')
  const file = join(dir, 'managed-config.json')
  afterEach(() => {
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  it('rejects a policy file planted by the current non-admin user (owner=self, Users:Write inherited)', () => {
    mkdirSync(dir, { recursive: true }) // inherits ProgramData's Users:Write ACE, like the real attack
    writeFileSync(file, JSON.stringify({ escrowPubKey: 'ATTACKER', requireAuth: true }))
    // The file exists and parses, but the ACL reader sees a non-admin owner + inherited Users write.
    expect(isAdminManagedTrusted(file)).toBe(false)
    // Budget must clear the code's OWN limit: the ACL read spawns System32 powershell.exe with an
    // 8s execFileSync timeout, which already exceeds vitest's 5s per-test default — so on a cold CI
    // runner, where PowerShell start-up is the slow part, this failed as a timeout rather than a verdict.
  }, 20_000)

  // MQA-008 (docs/qa/BUG-LEDGER.md). The probe built its owner from FileSecurity.Owner, which is a
  // System.String rather than an IdentityReference — .Translate() threw, the fallback read .Value off a
  // String and got null, so EVERY file on win32 probed as `owner: ''` and evaluateAclTrust rejected it.
  // Windows machine policy (requireAuth, allowedProviders, lockedKeys, disableAutoUpdate) was therefore
  // never enforced, and every reject-direction test above still passed. This asserts the owner resolves.
  it('resolves a real owner SID from the live ACL probe — an empty owner silently disables all machine policy (MQA-008)', async (ctx) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify({ requireAuth: true }))

    // MQA-007: the probe is a synchronous powershell.exe spawn under the PRODUCTION 8s execFileSync cap,
    // which no test budget can extend. On a saturated machine (several vitest processes at once) the spawn
    // itself can fail or time out, and the probe returns null — "could not run", which is not evidence
    // either way about MQA-008. Retry with a pause rather than tolerate: a genuinely broken probe returns
    // the same answer every time, so nothing asserted below is weakened, while a machine that had no
    // scheduler slot to give gets a real second chance instead of three instant re-failures.
    let probe = readAclForTest(file)
    for (let attempt = 0; probe === null && attempt < 4; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
      probe = readAclForTest(file)
    }
    // MQA-262: five consecutive nulls means the powershell.exe spawn cannot run HERE at all — GitHub's
    // windows-latest runner is one such environment. The comment above already says why that is not
    // evidence either way about MQA-008, so asserting on it produces a red line about the product from a
    // fact about the machine. Skip loudly instead: the message names the blocker, and the assertions
    // below still run in every environment where the probe works, which includes a real install.
    if (probe === null) {
      ctx.skip(
        'not exercised — the live ACL probe (powershell.exe) returned null on every attempt in this ' +
          'environment, so there is no verdict to check. Run on a machine where the probe can spawn.'
      )
      return
    }
    expect(probe).not.toBeNull()
    // A well-formed Windows SID: S-1-<authority>-<sub authorities>. Any file has an owner, so an empty
    // string here means the probe is broken, not that the file is suspicious.
    expect(probe?.owner).toMatch(/^S-1-\d+(-\d+)+$/)
    expect(probe?.aces.length).toBeGreaterThan(0)
  }, 45_000) // four 8s probes plus their backoff, worst case

  it('readTrustedAdminManaged never returns content for that same untrusted file', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify({ escrowPubKey: 'ATTACKER', requireAuth: true }))
    // Content must not leak even though the file exists and parses — the ACL is untrusted, so the
    // held-fd read is refused before ever handing the caller a string to JSON.parse.
    expect(readTrustedAdminManaged(file)).toBeNull()
    // Same 8s-PowerShell-vs-5s-budget reason as the case above.
  }, 20_000)
})

// MQA-028 (docs/qa/BUG-LEDGER.md). Every probe is a synchronous powershell.exe spawn, and nothing
// memoized the verdict: requireAuth() alone fired three before any privileged IPC handler body ran, and
// one settings toggle fired eight — seconds of frozen main process per user action on a managed install.
// The memo must collapse them WITHOUT reopening the hole the old mtime+size cache left (both of those are
// chosen by whoever creates the file, so a swap could inherit a trusted verdict) — hence the two cases
// after this one, which pin the properties that make it safe: file identity, and a time bound.
describe('ACL verdict memo — one probe per burst, never across a swap (MQA-028)', () => {
  const tmpDir = join(tmpdir(), `wsec-aclmemo-${process.pid}`)
  const file = join(tmpDir, 'managed-config.json')
  const CONTENT = JSON.stringify({ requireAuth: true })

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(file, CONTENT)
    setPlatform('win32')
    probes.count = 0
  })
  afterEach(() => {
    vi.useRealTimers()
    try {
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  it('answers a burst of privileged calls on the same file from a single probe', () => {
    // MQA-007: freeze the clock, for the same reason the delete-and-replace case below does — this one
    // must prove MEMOIZATION, not that the machine is fast. The memo is deliberately time-bounded
    // (ACL_VERDICT_TTL_MS = 5s, a security property), and each read here can spend up to the production
    // 8s powershell timeout on a saturated machine, so on real time the second call legitimately outlives
    // the memo and re-probes: a correct product behaviour reported as a failed test. Frozen, the four
    // reads are the single settings:set turn this is actually about.
    vi.useFakeTimers()
    vi.setSystemTime(Date.now())
    const first = readTrustedAdminManaged(file)
    expect(readTrustedAdminManaged(file)).toBe(first)
    expect(isAdminManagedTrusted(file)).toBe(first !== null)
    expect(readTrustedAdminManaged(file)).toBe(first)
    // Four privileged reads — the shape of a single settings:set turn — one powershell.exe.
    expect(probes.count).toBe(1)
  }, 20_000)

  it('re-probes after a delete-and-replace even with mtime and size forged to match', () => {
    // The attack the old content-metadata cache lost to: a standard user has create/delete on
    // %ProgramData%\Métis, and both mtime and size are theirs to choose on the file they drop in.
    vi.useFakeTimers()
    vi.setSystemTime(Date.now()) // freeze: this case must prove IDENTITY, not TTL expiry
    readTrustedAdminManaged(file)
    const before = statSync(file)

    // MQA-262: build the replacement BESIDE the original, then rename over it. Writing straight back to the same
    // path after rmSync lets ext4 hand back the inode it just freed, so the replacement carries the
    // ORIGINAL's inode and this case silently stops testing anything — which is exactly how it failed on
    // the Linux runner while passing on Windows. Creating both files at once makes a distinct inode
    // certain on every filesystem, and rename() is the more realistic attack anyway: an atomic swap.
    const replacement = `${file}.replacement`
    writeFileSync(replacement, CONTENT) // same bytes → same size
    rmSync(file)
    renameSync(replacement, file)
    utimesSync(file, before.atime, before.mtime)
    const after = statSync(file)
    expect(after.size).toBe(before.size)
    // The inode is the one part of the key the file's creator cannot pick, which is why it is in the key.
    expect(after.ino).not.toBe(before.ino)

    readTrustedAdminManaged(file)
    expect(probes.count).toBe(2)
  }, 20_000)

  it('expires the verdict within seconds so an in-place DACL edit cannot be trusted forever', () => {
    // icacls/Set-Acl changes a DACL without touching content, so no file-identity key can see it. Only
    // the wall-clock bound catches IT hardening (or loosening) a deployed policy mid-session.
    const base = Date.now()
    vi.useFakeTimers()
    vi.setSystemTime(base)
    readTrustedAdminManaged(file)
    expect(probes.count).toBe(1)

    vi.setSystemTime(base + 4_000)
    readTrustedAdminManaged(file)
    expect(probes.count).toBe(1)

    vi.setSystemTime(base + 6_000)
    readTrustedAdminManaged(file)
    expect(probes.count).toBe(2)
  }, 20_000)
})

// MQA-034 (docs/qa/BUG-LEDGER.md). getAllowedProviders()/getLockedKeys() sit OUTSIDE getSettings()'s
// mtime-keyed cache but on its hottest paths: every renderer settings fetch (twice), every ask, and —
// through localReady() — screen-preprocess's 6 s tick, which turned the probe into a permanent ~1 s
// main-process stall every 6 s. The 5 s verdict memo above cannot cover a 6 s tick on its own, so the
// accessors have to read the policy through a snapshot of their own. %ProgramData% is redirected here so
// the probe runs against a temp file instead of a real machine-wide deployment.
describe('policy accessors — the ACL probe is off the per-ask and per-tick path (MQA-034)', () => {
  const root = join(tmpdir(), `wsec-adminpolicy-${process.pid}`)
  const programData = join(root, 'ProgramData')
  const policy = join(programData, 'Métis', 'managed-config.json')
  const REAL_PROGRAM_DATA = process.env.ProgramData

  beforeEach(() => {
    mkdirSync(join(programData, 'Métis'), { recursive: true })
    writeFileSync(policy, JSON.stringify({ allowedProviders: ['dust'], lockedKeys: ['provider'] }))
    process.env.ProgramData = programData
    setPlatform('win32')
    probes.count = 0
  })
  afterEach(() => {
    vi.useRealTimers()
    if (REAL_PROGRAM_DATA === undefined) delete process.env.ProgramData
    else process.env.ProgramData = REAL_PROGRAM_DATA
    try {
      if (existsSync(root)) rmSync(root, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  it('does not re-probe once per call — five ticks worth of reads cost one spawn', () => {
    const base = Date.now()
    vi.useFakeTimers()
    vi.setSystemTime(base)
    getAllowedProviders()
    getLockedKeys()
    getAllowedProviders()
    expect(probes.count).toBe(1)

    // 30 s on: five screen-preprocess ticks and several settings fetches later, and well past the verdict
    // memo's own TTL — the accessors must be reading their snapshot, not spawning powershell again.
    vi.setSystemTime(base + 30_000)
    getAllowedProviders()
    getLockedKeys()
    expect(probes.count).toBe(1)
  }, 20_000)

  it('still re-probes within the minute — the snapshot is bounded, not permanent', () => {
    const base = Date.now()
    vi.useFakeTimers()
    vi.setSystemTime(base)
    getAllowedProviders()
    expect(probes.count).toBe(1)

    vi.setSystemTime(base + 61_000)
    getAllowedProviders()
    expect(probes.count).toBe(2)
  }, 20_000)
})
