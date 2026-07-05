import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { evaluateAclTrust, isAdminManagedTrusted, trustedAdminManagedPath, type AclProbe } from './win-security'

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

  it('trusts an ABSENT win32 policy file (nothing to distrust; readers get null anyway)', () => {
    setPlatform('win32')
    // A path that does not exist → statSync throws → treated as absent → trusted, so callers fall through
    // to the per-user managed file exactly as before.
    expect(isAdminManagedTrusted('C:\\ProgramData\\Métis\\__does_not_exist__.json')).toBe(true)
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
})
