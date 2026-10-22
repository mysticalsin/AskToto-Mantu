import { describe, expect, it } from 'vitest'
import { MODIFIER_BITS as B } from '@shared/voice/modifier-mask'
import {
  RESTART_BACKOFF_MS,
  createChordWatcher,
  type ChordGateBlock,
  type ChordWatcherEvent,
  type ChordWatcherStatus
} from './chord-watcher'
import type { LineHelperHandle, LineHelperHandlers } from '../infra/process/line-helper-host'

const RCMD = B.rightCommand
const SPEC = { command: '/synthetic/mac-helper', args: ['watch-modifiers', '--interval-ms', '40'] } as const

interface FakeHelper {
  readonly handlers: LineHelperHandlers
  killed: boolean
}

function setup(initial: { enabled?: boolean; spec?: typeof SPEC | null; chordMask?: number; latch?: boolean } = {}) {
  const world = {
    enabled: initial.enabled ?? true,
    signedIn: true,
    gate: null as ChordGateBlock | null,
    chordMask: initial.chordMask ?? RCMD,
    assistive: false,
    spec: initial.spec === undefined ? SPEC : initial.spec,
    spawnFails: false,
    clock: 1_000_000
  }
  const helpers: FakeHelper[] = []
  const events: ChordWatcherEvent[] = []
  const statuses: ChordWatcherStatus[] = []
  const audits: Array<{ event: string; data: Record<string, unknown> }> = []
  const timers: Array<{ id: number; at: number; cb: () => void; cleared: boolean }> = []
  let nextTimer = 1
  let seq = 10

  const watcher = createChordWatcher({
    helperSpec: () => world.spec,
    spawnHelper: (_spec, handlers): LineHelperHandle => {
      if (world.spawnFails) throw new Error('spawn failed')
      const helper: FakeHelper = { handlers, killed: false }
      helpers.push(helper)
      return {
        kill: () => {
          helper.killed = true
        }
      }
    },
    enabled: () => world.enabled,
    signedIn: () => world.signedIn,
    gate: () => world.gate,
    chordMask: () => world.chordMask,
    latchEnabled: initial.latch === undefined ? undefined : () => initial.latch === true,
    assistiveTechnologyActive: () => world.assistive,
    now: () => world.clock,
    timers: {
      set: (cb, ms) => {
        const timer = { id: nextTimer++, at: world.clock + ms, cb, cleared: false }
        timers.push(timer)
        return timer.id
      },
      clear: (id) => {
        const timer = timers.find((t) => t.id === id)
        if (timer) timer.cleared = true
      }
    },
    onEvent: (event) => events.push(event),
    onStatus: (status) => statuses.push(status),
    audit: (event, data) => audits.push({ event, data })
  })

  const advance = (ms: number): void => {
    const target = world.clock + ms
    for (;;) {
      const due = timers.filter((t) => !t.cleared && t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (!due) break
      due.cleared = true
      world.clock = Math.max(world.clock, due.at)
      due.cb()
    }
    world.clock = target
  }
  const live = (): FakeHelper => {
    const helper = helpers[helpers.length - 1]
    if (!helper || helper.killed) throw new Error('no live helper')
    return helper
  }
  const send = (mask: number, otherKey = false): void => {
    if (otherKey) seq += 1
    live().handlers.onLine(`m ${mask} ${seq}`)
  }
  const crash = (): void => live().handlers.onExit({ code: 1, signal: null })
  const pendingTimers = (): number => timers.filter((t) => !t.cleared).length
  return { world, watcher, helpers, events, statuses, audits, advance, live, send, crash, pendingTimers }
}

/** Start, baseline, hold the chord past the threshold. */
function arm(t: ReturnType<typeof setup>): void {
  t.watcher.refresh()
  t.send(0)
  t.send(RCMD)
  t.advance(250)
}

describe('inert unless voice actions are enabled', () => {
  it('creating the watcher spawns nothing and arms no timer', () => {
    const t = setup()
    expect(t.helpers).toHaveLength(0)
    expect(t.pendingTimers()).toBe(0)
    expect(t.watcher.status()).toBe('inert')
  })

  it('disabled: no helper process, no key monitoring, however often it is refreshed', () => {
    const t = setup({ enabled: false })
    t.watcher.refresh()
    t.watcher.refresh()
    expect(t.helpers).toHaveLength(0)
    expect(t.watcher.status()).toBe('inert')
    expect(t.audits).toEqual([])
  })

  it('no platform helper (Windows without the artifact, Linux): nothing to spawn', () => {
    const t = setup({ spec: null })
    t.watcher.refresh()
    expect(t.helpers).toHaveLength(0)
    expect(t.watcher.status()).toBe('inert')
  })

  it('enabled: spawns the helper exactly once', () => {
    const t = setup()
    t.watcher.refresh()
    t.watcher.refresh()
    expect(t.helpers).toHaveLength(1)
    expect(t.watcher.status()).toBe('running')
  })

  it('turning the feature off kills the helper and ends an open turn', () => {
    const t = setup()
    arm(t)
    t.world.enabled = false
    t.watcher.refresh()
    expect(t.helpers[0].killed).toBe(true)
    expect(t.watcher.status()).toBe('inert')
    expect(t.events).toEqual([{ type: 'armed' }, { type: 'revoked', cause: 'disabled' }])
  })

  it('signed out: never starts', () => {
    const t = setup()
    t.world.signedIn = false
    t.watcher.refresh()
    expect(t.helpers).toHaveLength(0)
    expect(t.watcher.status()).toBe('paused')
  })
})

describe('chord events', () => {
  it('forwards armed and released for a clean hold', () => {
    const t = setup()
    arm(t)
    t.advance(500)
    t.send(0)
    expect(t.events).toEqual([{ type: 'armed' }, { type: 'released', reason: 'release' }])
  })

  it('a short press and a shortcut produce nothing', () => {
    const t = setup()
    t.watcher.refresh()
    t.send(0)
    t.send(RCMD)
    t.advance(100)
    t.send(0)
    t.advance(500)
    t.send(RCMD)
    t.send(RCMD, true)
    t.advance(1_000)
    t.send(0)
    expect(t.events).toEqual([])
  })

  it('the 15 s cap arrives by timer with no helper line', () => {
    const t = setup()
    arm(t)
    t.advance(15_000)
    expect(t.events).toEqual([{ type: 'armed' }, { type: 'released', reason: 'cap' }])
  })

  it('drops malformed helper lines and audits the problem once, never the line itself', () => {
    const t = setup()
    t.watcher.refresh()
    const { onLine } = t.live().handlers
    onLine('garbage')
    onLine('m 1')
    onLine('key 55 down')
    onLine('m 99999 0')
    expect(t.events).toEqual([])
    const protocolAudits = t.audits.filter((a) => a.data.kind === 'protocol-error')
    expect(protocolAudits).toHaveLength(1)
    expect(JSON.stringify(protocolAudits)).not.toContain('garbage')
  })

  it('a changed chord takes effect on the next refresh', () => {
    const t = setup()
    t.watcher.refresh()
    t.send(0)
    t.world.chordMask = B.rightControl
    t.watcher.refresh()
    t.send(RCMD)
    t.advance(300)
    expect(t.events).toEqual([])
    t.send(0)
    t.send(B.rightControl)
    t.advance(250)
    expect(t.events).toEqual([{ type: 'armed' }])
  })

  it('reports a Control+Option chord as suspended while assistive technology is on', () => {
    const t = setup({ chordMask: B.leftControl | B.leftAlt })
    t.world.assistive = true
    t.watcher.refresh()
    expect(t.watcher.suspendedReason()).toBe('assistive-technology')
    t.send(0)
    t.send(B.leftControl | B.leftAlt)
    t.advance(1_000)
    expect(t.events).toEqual([])
  })
})

describe('arbitration: never while Métis records a meeting', () => {
  it('a hold during a meeting never arms; the consumer gets a refusal to explain it', () => {
    const t = setup()
    t.world.gate = 'meeting'
    arm(t)
    t.advance(500)
    t.send(0)
    expect(t.events).toEqual([{ type: 'refused', reason: 'meeting' }])
  })

  it('other blocks (onboarding, recorder) drop the hold silently', () => {
    const t = setup()
    t.world.gate = 'onboarding'
    arm(t)
    t.send(0)
    expect(t.events).toEqual([])
  })

  it('a meeting that starts mid-turn revokes the open turn', () => {
    const t = setup()
    arm(t)
    t.world.gate = 'meeting'
    t.watcher.lifecycle('meeting-started')
    expect(t.events).toEqual([{ type: 'armed' }, { type: 'revoked', cause: 'meeting-started' }])
    t.send(0)
    expect(t.events).toHaveLength(2)
  })
})

describe('lifecycle: lock, suspend, sign-out and quit stop the helper', () => {
  it('lock ends the open turn, kills the child and stays down until unlock', () => {
    const t = setup()
    arm(t)
    t.watcher.lifecycle('lock')
    expect(t.helpers[0].killed).toBe(true)
    expect(t.events).toEqual([{ type: 'armed' }, { type: 'revoked', cause: 'lock' }])
    t.watcher.refresh()
    expect(t.helpers).toHaveLength(1)
    expect(t.watcher.status()).toBe('paused')
    t.watcher.lifecycle('unlock')
    expect(t.helpers).toHaveLength(2)
    expect(t.watcher.status()).toBe('running')
  })

  it('suspend and resume behave the same way, and lock plus suspend both have to clear', () => {
    const t = setup()
    t.watcher.refresh()
    t.watcher.lifecycle('suspend')
    t.watcher.lifecycle('lock')
    t.watcher.lifecycle('resume')
    expect(t.helpers).toHaveLength(1)
    t.watcher.lifecycle('unlock')
    expect(t.helpers).toHaveLength(2)
    expect(t.helpers[0].killed).toBe(true)
  })

  it('sign-out kills the child; only an explicit sign-in restarts it', () => {
    const t = setup()
    arm(t)
    t.world.signedIn = false
    t.watcher.lifecycle('sign-out')
    expect(t.helpers[0].killed).toBe(true)
    expect(t.events).toEqual([{ type: 'armed' }, { type: 'revoked', cause: 'sign-out' }])
    t.world.signedIn = true
    t.watcher.refresh()
    expect(t.helpers).toHaveLength(1)
    t.watcher.lifecycle('sign-in')
    expect(t.helpers).toHaveLength(2)
  })

  it('a sign-out that fires before the session is cleared still stops the child', () => {
    const t = setup()
    t.watcher.refresh()
    t.watcher.lifecycle('sign-out')
    expect(t.world.signedIn).toBe(true)
    expect(t.helpers[0].killed).toBe(true)
    expect(t.watcher.status()).toBe('paused')
  })

  it('quit kills the child for good and clears pending timers', () => {
    const t = setup()
    arm(t)
    t.watcher.stop()
    t.watcher.stop()
    expect(t.helpers[0].killed).toBe(true)
    expect(t.pendingTimers()).toBe(0)
    expect(t.events).toEqual([{ type: 'armed' }, { type: 'revoked', cause: 'quit' }])
    t.watcher.refresh()
    t.watcher.lifecycle('unlock')
    expect(t.helpers).toHaveLength(1)
    expect(t.watcher.status()).toBe('stopped')
  })

  it('lines from a killed helper are ignored', () => {
    const t = setup()
    t.watcher.refresh()
    const old = t.helpers[0]
    t.watcher.lifecycle('lock')
    t.watcher.lifecycle('unlock')
    old.handlers.onLine('m 32 0')
    old.handlers.onExit({ code: 1, signal: null })
    expect(t.helpers).toHaveLength(2)
    expect(t.watcher.status()).toBe('running')
    expect(t.events).toEqual([])
  })
})

describe('supervised child: bounded restarts', () => {
  it('restarts with 1, 2, 4, 8, 8 s backoff, then gives up on the sixth failure inside 10 minutes', () => {
    expect(RESTART_BACKOFF_MS).toEqual([1_000, 2_000, 4_000, 8_000])
    const t = setup()
    t.watcher.refresh()
    const delays = [1_000, 2_000, 4_000, 8_000, 8_000]
    delays.forEach((delay, index) => {
      t.crash()
      expect(t.watcher.status()).toBe('restarting')
      t.advance(delay - 1)
      expect(t.helpers).toHaveLength(index + 1)
      t.advance(1)
      expect(t.helpers).toHaveLength(index + 2)
      expect(t.watcher.status()).toBe('running')
    })
    t.crash()
    expect(t.watcher.status()).toBe('failed')
    t.advance(60_000)
    expect(t.helpers).toHaveLength(6)
    expect(t.statuses).toContain('failed')
    expect(t.audits.some((a) => a.data.kind === 'gave-up')).toBe(true)
    t.watcher.refresh()
    expect(t.helpers).toHaveLength(6)
  })

  it('failures spread over more than 10 minutes never exhaust the budget', () => {
    const t = setup()
    t.watcher.refresh()
    for (let i = 0; i < 12; i += 1) {
      t.crash()
      t.advance(1_000)
      t.advance(11 * 60_000)
      expect(t.watcher.status()).toBe('running')
    }
    expect(t.helpers).toHaveLength(13)
  })

  it('a spawn that throws counts as a failure and retries', () => {
    const t = setup()
    t.world.spawnFails = true
    t.watcher.refresh()
    expect(t.watcher.status()).toBe('restarting')
    t.world.spawnFails = false
    t.advance(1_000)
    expect(t.helpers).toHaveLength(1)
    expect(t.watcher.status()).toBe('running')
  })

  it('a crash while armed revokes the open turn and a restarted helper starts from a fresh baseline', () => {
    const t = setup()
    arm(t)
    t.crash()
    expect(t.events).toEqual([{ type: 'armed' }, { type: 'revoked', cause: 'helper-lost' }])
    t.advance(1_000)
    // The person is still holding the chord: it has to be released before the next press can arm.
    t.live().handlers.onLine('m 32 3')
    t.advance(1_000)
    expect(t.events).toHaveLength(2)
    t.live().handlers.onLine('m 0 3')
    t.live().handlers.onLine('m 32 3')
    t.advance(250)
    expect(t.events[t.events.length - 1]).toEqual({ type: 'armed' })
  })

  it('stopping cancels a scheduled restart', () => {
    const t = setup()
    t.watcher.refresh()
    t.crash()
    t.watcher.stop()
    t.advance(60_000)
    expect(t.helpers).toHaveLength(1)
  })

  it('a lifecycle pause cancels a scheduled restart, and the unlock starts a fresh run', () => {
    const t = setup()
    t.watcher.refresh()
    t.crash()
    t.watcher.lifecycle('lock')
    t.advance(60_000)
    expect(t.helpers).toHaveLength(1)
    t.watcher.lifecycle('unlock')
    expect(t.helpers).toHaveLength(2)
  })
})

describe('double-press latch is off unless the setting turns it on', () => {
  const doublePress = (t: ReturnType<typeof setup>): void => {
    t.watcher.refresh()
    t.send(0)
    t.send(RCMD)
    t.advance(100)
    t.send(0)
    t.advance(100)
    t.send(RCMD)
  }

  it('by default a quick second press never latches hands-free listening', () => {
    const t = setup()
    doublePress(t)
    expect(t.events.some((e) => e.type === 'latched')).toBe(false)
  })

  it('an explicit latchEnabled false behaves the same', () => {
    const t = setup({ latch: false })
    doublePress(t)
    expect(t.events.some((e) => e.type === 'latched')).toBe(false)
  })

  it('latchEnabled true restores the double-press latch', () => {
    const t = setup({ latch: true })
    doublePress(t)
    expect(t.events.some((e) => e.type === 'latched')).toBe(true)
  })
})
