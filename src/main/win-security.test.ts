import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  evaluateAclTrust,
  isAdminManagedTrusted,
  readTrustedAdminManaged,
  trustedAdminManagedPath,
  WINDOWS_POWERSHELL,
  type AclProbe
} from './win-security'

const REAL_PLATFORM = process.platform
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}
afterEach(() => Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true }))

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
  })

  it('readTrustedAdminManaged never returns content for that same untrusted file', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify({ escrowPubKey: 'ATTACKER', requireAuth: true }))
    // Content must not leak even though the file exists and parses — the ACL is untrusted, so the
    // held-fd read is refused before ever handing the caller a string to JSON.parse.
    expect(readTrustedAdminManaged(file)).toBeNull()
  })
})
