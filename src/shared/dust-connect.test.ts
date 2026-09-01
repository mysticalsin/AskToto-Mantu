import { describe, expect, it } from 'vitest'
import {
  countDustPrivilegeSpawns,
  dustBinCandidates,
  dustRowCopy,
  dustRowCopyIsHonest,
  isDustCliConnected,
  nextDustConnectStep,
  preferMantuWorkspace,
  windowsPrivilegeSpawnKinds,
  type DustConnectStatus,
  type DustPrivilegeEvent
} from './dust-connect'

describe('nextDustConnectStep', () => {
  it('installs first when the Connect binary is missing', () => {
    expect(
      nextDustConnectStep({
        binaryPresent: false,
        sessionLive: false,
        installAttempted: false,
        installOk: null,
        loginAttempted: false
      })
    ).toEqual({ action: 'install' })
  })

  it('fails closed when install ran but detect still misses', () => {
    expect(
      nextDustConnectStep({
        binaryPresent: false,
        sessionLive: true,
        installAttempted: true,
        installOk: true,
        loginAttempted: true
      })
    ).toEqual({ action: 'fail', reason: 'missing-binary' })
  })

  it('logs in after a successful install when the session is not live', () => {
    expect(
      nextDustConnectStep({
        binaryPresent: true,
        sessionLive: false,
        installAttempted: true,
        installOk: true,
        loginAttempted: false
      })
    ).toEqual({ action: 'login' })
  })

  it('is done only when the same binary is present and the session is live', () => {
    expect(
      nextDustConnectStep({
        binaryPresent: true,
        sessionLive: true,
        installAttempted: true,
        installOk: true,
        loginAttempted: true
      })
    ).toEqual({ action: 'done' })
  })
})

describe('countDustPrivilegeSpawns — one consent', () => {
  it('collapses install + login + import under one session to 1 (Mac)', () => {
    const sessionId = 'connect-1'
    const events: DustPrivilegeEvent[] = [
      { kind: 'electron-helper', sessionId },
      { kind: 'osascript', sessionId },
      { kind: 'keychain', sessionId }
    ]
    expect(countDustPrivilegeSpawns(events)).toBe(1)
  })

  it('three separate privileged spawns (the Tony bug) count as 3', () => {
    const events: DustPrivilegeEvent[] = [
      { kind: 'sudo', sessionId: 'install' },
      { kind: 'osascript', sessionId: 'login' },
      { kind: 'keychain', sessionId: 'import' }
    ]
    expect(countDustPrivilegeSpawns(events)).toBe(3)
  })

  it('Windows install+login must not open three elevations', () => {
    const sessionId = 'connect-win'
    const events: DustPrivilegeEvent[] = [{ kind: 'authorization', sessionId }]
    expect(countDustPrivilegeSpawns(events)).toBe(1)
    expect(windowsPrivilegeSpawnKinds(events)).toEqual([])
  })

  it('Windows UAC + npm-global + helper as three sessions is the bug', () => {
    const events: DustPrivilegeEvent[] = [
      { kind: 'uac', sessionId: 'uac' },
      { kind: 'npm-global', sessionId: 'npm' },
      { kind: 'electron-helper', sessionId: 'helper' }
    ]
    expect(countDustPrivilegeSpawns(events)).toBe(3)
    expect(windowsPrivilegeSpawnKinds(events)).toHaveLength(3)
  })
})

describe('dustRowCopy — Connected cannot mean not-yet-installed', () => {
  const cases: DustConnectStatus[] = [
    { installed: false, live: false },
    { installed: true, live: false },
    { installed: false, live: true, workspaceId: 'ws_mantu' },
    { installed: true, live: true, workspaceId: 'ws_mantu', workspaceName: 'Mantu' }
  ]

  it('every status is honest', () => {
    for (const s of cases) {
      const copy = dustRowCopy(s)
      expect(dustRowCopyIsHonest(s, copy), JSON.stringify({ s, copy })).toBe(true)
    }
  })

  it('success is installed+live and names Mantu', () => {
    const copy = dustRowCopy({
      installed: true,
      live: true,
      workspaceId: 'ws_mantu',
      workspaceName: 'Mantu'
    })
    expect(copy.headline).toMatch(/connected/i)
    expect(copy.headline).toMatch(/installed/i)
    expect(copy.headline).toMatch(/live/i)
    expect(copy.headline).toMatch(/Mantu/)
    expect(copy.headline).not.toMatch(/not yet installed/i)
    expect(isDustCliConnected({ installed: true, live: true })).toBe(true)
  })

  it('a live session without the Connect binary is not Connected', () => {
    const s = { installed: false, live: true, workspaceId: 'ws_mantu' }
    const copy = dustRowCopy(s)
    expect(isDustCliConnected(s)).toBe(false)
    expect(copy.headline).toMatch(/not yet installed/i)
    expect(copy.headline).not.toMatch(/connected/i)
    expect(dustRowCopyIsHonest(s, copy)).toBe(true)
  })
})

describe('preferMantuWorkspace', () => {
  it('picks Mantu after login when it is in the list', () => {
    const picked = preferMantuWorkspace([
      { sId: 'ws_other', name: 'Playground' },
      { sId: 'ws_mantu', name: 'Mantu' },
      { sId: 'ws_eu', name: 'Mantu EU' }
    ])
    expect(picked).toEqual({ sId: 'ws_mantu', name: 'Mantu' })
  })

  it('returns null for an empty list', () => {
    expect(preferMantuWorkspace([])).toBeNull()
  })
})

describe('dustBinCandidates — managed, then hermes, then PATH', () => {
  it('Mac: userData managed entry wins over ~/.hermes and PATH dust', () => {
    const list = dustBinCandidates({
      platform: 'darwin',
      userData: '/Users/tony/Library/Application Support/Métis',
      home: '/Users/tony',
      managedEntry: '/Users/tony/Library/Application Support/Métis/managed-cli/dust/0.4.5/package/dist/index.js'
    })
    expect(list[0]).toContain('managed-cli/dust')
    expect(list.some((p) => p.endsWith('/.hermes/node/bin/dust'))).toBe(true)
    expect(list.some((p) => p.endsWith('/.hermes/bin/dust'))).toBe(true)
    expect(list.indexOf('/Users/tony/.hermes/node/bin/dust')).toBeLessThan(
      list.indexOf('/Users/tony/.hermes/bin/dust')
    )
    expect(list[list.length - 1]).toBe('dust')
  })

  it('Windows: managed, then .hermes dust.cmd, then PATH names — no third UAC prefix', () => {
    const list = dustBinCandidates({
      platform: 'win32',
      userData: 'C:\\Users\\tony\\AppData\\Roaming\\Metis',
      home: 'C:\\Users\\tony',
      managedEntry: 'C:\\Users\\tony\\AppData\\Roaming\\Metis\\managed-cli\\dust\\0.4.5\\package\\dist\\index.js'
    })
    expect(list[0]).toContain('managed-cli')
    expect(list.some((p) => p.includes('.hermes\\node\\bin') && p.endsWith('dust.cmd'))).toBe(true)
    expect(list.some((p) => p.includes('.hermes\\bin') && p.endsWith('dust.cmd'))).toBe(true)
    expect(list).toContain('dust.cmd')
    expect(list).toContain('dust.exe')
  })
})
