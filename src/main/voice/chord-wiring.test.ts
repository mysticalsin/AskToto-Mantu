import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MODIFIER_BITS as B } from '@shared/voice/modifier-mask'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', isAccessibilitySupportEnabled: () => false },
  powerMonitor: { on: vi.fn() }
}))
vi.mock('../logger', () => ({ mainLog: { info: vi.fn(), warn: vi.fn() }, auditLog: vi.fn() }))

import {
  VOICE_ACTIONS_RELEASE_DEFAULT,
  createVoiceChordWiring,
  resolveVoiceActionsEnabled,
  winKeywatchSpawnSpec,
  type VoiceChordWiringDeps
} from './chord-wiring'
import type { LineHelperHandlers } from '../infra/process/line-helper-host'

type PowerEvent = 'lock-screen' | 'unlock-screen' | 'suspend' | 'resume'

function build(overrides: Partial<VoiceChordWiringDeps> = {}) {
  const spawned: Array<{ command: string; args: readonly string[]; killed: boolean; handlers: LineHelperHandlers }> = []
  const power = new Map<PowerEvent, () => void>()
  const audits: Array<{ event: string; data: Record<string, unknown> }> = []
  const chordEvents: unknown[] = []
  const state = { signedIn: true, meeting: false, onboarding: false }
  const wiring = createVoiceChordWiring({
    platform: 'darwin',
    qaIdentityBuild: true,
    requireAuth: () => state.signedIn,
    meetingReserved: () => state.meeting,
    onboardingExclusive: () => state.onboarding,
    isAccessibilitySupportEnabled: () => false,
    power: { on: (event, callback) => void power.set(event, callback) },
    helperSpec: () => ({ command: '/synthetic/mac-helper', args: ['watch-modifiers', '--interval-ms', '40'] }),
    spawnHelper: (spec, handlers) => {
      const record = { command: spec.command, args: spec.args, killed: false, handlers }
      spawned.push(record)
      return {
        kill: () => {
          record.killed = true
        }
      }
    },
    audit: (event, data) => audits.push({ event, data }),
    log: () => undefined,
    onChordEvent: (event) => chordEvents.push(event),
    ...overrides
  })
  return { wiring, spawned, power, audits, chordEvents, state }
}

describe('resolveVoiceActionsEnabled: Preview, off by default in release builds', () => {
  it('release builds stay off until the owner flips the default or the person opts in', () => {
    expect(VOICE_ACTIONS_RELEASE_DEFAULT).toBe(false)
    expect(resolveVoiceActionsEnabled({ qaIdentityBuild: false, userEnabled: undefined })).toBe(false)
    expect(resolveVoiceActionsEnabled({ qaIdentityBuild: false, userEnabled: true })).toBe(true)
    expect(resolveVoiceActionsEnabled({ qaIdentityBuild: false, userEnabled: false })).toBe(false)
  })

  it('QA builds are on unless the person turned it off', () => {
    expect(resolveVoiceActionsEnabled({ qaIdentityBuild: true, userEnabled: undefined })).toBe(true)
    expect(resolveVoiceActionsEnabled({ qaIdentityBuild: true, userEnabled: false })).toBe(false)
  })
})

describe('createVoiceChordWiring', () => {
  it('a release build with no opt-in never spawns a helper, at boot or on any refresh', () => {
    const t = build({ qaIdentityBuild: false })
    t.wiring.start()
    t.wiring.refresh()
    expect(t.spawned).toHaveLength(0)
    expect(t.wiring.status()).toBe('inert')
  })

  it('a QA build spawns the helper at start and only once', () => {
    const t = build()
    t.wiring.start()
    t.wiring.refresh()
    expect(t.spawned).toHaveLength(1)
    expect(t.spawned[0].args).toEqual(['watch-modifiers', '--interval-ms', '40'])
    expect(t.wiring.status()).toBe('running')
  })

  it('an explicit opt-in turns a release build on, and the same wiring turns it off again', () => {
    let optIn: boolean | undefined = true
    const t = build({ qaIdentityBuild: false, userEnabled: () => optIn })
    t.wiring.start()
    expect(t.spawned).toHaveLength(1)
    optIn = false
    t.wiring.refresh()
    expect(t.spawned[0].killed).toBe(true)
  })

  it('Windows without the helper artifact, and Linux, stay inert', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const t = build({ platform, helperSpec: () => null })
      t.wiring.start()
      expect(t.spawned).toHaveLength(0)
    }
  })

  it('registers the four power events and stops the helper on lock and suspend, restarting on unlock and resume', () => {
    const t = build()
    t.wiring.start()
    expect([...t.power.keys()].sort()).toEqual(['lock-screen', 'resume', 'suspend', 'unlock-screen'])
    t.power.get('lock-screen')?.()
    expect(t.spawned[0].killed).toBe(true)
    t.power.get('unlock-screen')?.()
    expect(t.spawned).toHaveLength(2)
    t.power.get('suspend')?.()
    expect(t.spawned[1].killed).toBe(true)
    t.power.get('resume')?.()
    expect(t.spawned).toHaveLength(3)
  })

  it('sign-out, auth revocation and shutdown stop it; plain window or ownership churn does not', () => {
    const t = build()
    t.wiring.start()
    t.wiring.onInputSessionStop('window-hidden')
    t.wiring.onInputSessionStop('cancelled')
    t.wiring.onInputSessionStop('owner-replaced')
    expect(t.spawned[0].killed).toBe(false)
    t.state.signedIn = false
    t.wiring.onInputSessionStop('sign-out')
    expect(t.spawned[0].killed).toBe(true)
    t.state.signedIn = true
    t.wiring.refresh()
    expect(t.spawned).toHaveLength(1)
    t.wiring.onSignedIn()
    expect(t.spawned).toHaveLength(2)
    t.wiring.onInputSessionStop('auth-revoked')
    expect(t.spawned[1].killed).toBe(true)
    t.wiring.refresh()
    expect(t.spawned).toHaveLength(2)
    t.wiring.onSignedIn()
    expect(t.spawned).toHaveLength(3)
    t.wiring.onInputSessionStop('shutdown')
    expect(t.spawned[2].killed).toBe(true)
    t.wiring.refresh()
    t.wiring.onSignedIn()
    expect(t.spawned).toHaveLength(3)
  })

  it('stop() is the quit path: kills the helper, idempotent', () => {
    const t = build()
    t.wiring.start()
    t.wiring.stop()
    t.wiring.stop()
    expect(t.spawned[0].killed).toBe(true)
    expect(t.wiring.status()).toBe('stopped')
  })

  it('a hold while a meeting is reserved is refused, reaches the consumer, and never starts anything', () => {
    vi.useFakeTimers()
    try {
      const t = build()
      t.state.meeting = true
      t.wiring.start()
      const { onLine } = t.spawned[0].handlers
      onLine('m 0 5')
      onLine('m 32 5')
      vi.advanceTimersByTime(260)
      expect(t.chordEvents).toEqual([{ type: 'refused', reason: 'meeting' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('audits chord events by type only: no key identity, no text', () => {
    vi.useFakeTimers()
    try {
      const t = build()
      t.wiring.start()
      const { onLine } = t.spawned[0].handlers
      onLine('m 0 5')
      onLine('m 32 5')
      vi.advanceTimersByTime(260)
      onLine('m 0 5')
      expect(t.chordEvents).toEqual([{ type: 'armed' }, { type: 'released', reason: 'release' }])
      const eventAudits = t.audits.filter((a) => a.data.kind === 'event')
      expect(eventAudits.map((a) => a.data.type)).toEqual(['armed', 'released'])
      for (const a of t.audits) expect(Object.keys(a.data).every((k) => /^[a-z-]+$/i.test(k))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('defers to the onboarding exclusive gate and the chord recorder', () => {
    vi.useFakeTimers()
    try {
      const t = build({ chordRecorderActive: () => true })
      t.wiring.start()
      const { onLine } = t.spawned[0].handlers
      onLine('m 0 1')
      onLine('m 32 1')
      vi.advanceTimersByTime(300)
      onLine('m 0 1')
      expect(t.chordEvents).toEqual([])
      const u = build()
      u.state.onboarding = true
      u.wiring.start()
      u.spawned[0].handlers.onLine('m 0 1')
      u.spawned[0].handlers.onLine('m 32 1')
      vi.advanceTimersByTime(300)
      expect(u.chordEvents).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('winKeywatchSpawnSpec (BLOCKED until the artifact is built and shipped)', () => {
  const resources = join('C:', 'synthetic', 'resources')
  const expected = join(resources, 'win-keywatch', 'metis-keywatch.exe')

  it('is null while the binary is absent, which is every build today', () => {
    expect(winKeywatchSpawnSpec({ resourcesPath: resources, exists: () => false })).toBeNull()
  })

  it('names the shipped binary and the shared protocol arguments once it exists', () => {
    expect(winKeywatchSpawnSpec({ resourcesPath: resources, exists: (p) => p === expected })).toEqual({
      command: expected,
      args: ['--interval-ms', '40']
    })
  })

  it('without a resources path there is nothing to spawn', () => {
    expect(winKeywatchSpawnSpec({ resourcesPath: '', exists: () => true })).toBeNull()
  })

  it('the default Windows chord is Right Ctrl, so AltGr (Left Ctrl + Right Alt) is excluded', () => {
    expect(B.rightControl & (B.leftControl | B.rightAlt)).toBe(0)
  })
})
