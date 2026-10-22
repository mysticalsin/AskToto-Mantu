import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  captureReasonForPhase,
  createScreenObservation,
  ScreenObservationRefusedError,
  type CapturedFrame,
  type ScreenObservationDeps,
  type ScreenRevocationReason
} from './screen-observation'

class PrivateViewError extends Error {
  constructor() {
    super('Private View is on — screen capture is blocked.')
    this.name = 'PrivateViewBlockedError'
  }
}

type CaptureRequest = { displayId: number; region?: { x: number; y: number; width: number; height: number } }

function makeHarness(init: { background?: boolean; access?: string; prewarm?: boolean } = {}) {
  let clock = 1_000_000
  const state = {
    privateView: false,
    access: init.access ?? 'granted',
    background: init.background ?? true,
    prewarm: init.prewarm ?? true,
    cursorDisplay: 7,
    capturedDisplay: null as number | null,
    mismatch: false,
    defer: false
  }
  const calls: CaptureRequest[] = []
  const gates: Array<() => void> = []
  const audits: { event: string; data?: Record<string, unknown> }[] = []
  const captureOnce = vi.fn(async (request: CaptureRequest): Promise<CapturedFrame> => {
    calls.push(request)
    const n = calls.length
    if (state.defer) await new Promise<void>((resolve) => gates.push(resolve))
    return {
      image: `synthetic-frame-${n}`,
      width: 1280,
      height: 800,
      dispId: state.capturedDisplay ?? request.displayId,
      displayMismatch: state.mismatch
    }
  })
  const deps: ScreenObservationDeps = {
    captureOnce,
    cursorDisplayId: () => state.cursorDisplay,
    privateViewOn: () => state.privateView,
    privateViewBlockedError: () => new PrivateViewError(),
    screenAccess: () => state.access,
    backgroundAllowed: () => state.background,
    prewarmAllowed: () => state.prewarm,
    now: () => clock,
    audit: (event, data) => {
      audits.push({ event, data })
    }
  }
  const observation = createScreenObservation(deps)
  return {
    observation,
    state,
    calls,
    audits,
    captureOnce,
    advance: (ms: number) => {
      clock += ms
    },
    release: () => {
      for (const open of gates.splice(0)) open()
    }
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('screen observation identity (G16)', () => {
  it('stamps every capture with a source id, a scope, a generation and a monotonic sequence', async () => {
    const h = makeHarness()
    const first = await h.observation.capture({ reason: 'ask' })
    expect(first.observation).toMatchObject({
      sourceId: 'display:7',
      scope: 'display',
      generation: 0,
      sequence: 1,
      capturedAt: first.capturedAt
    })
    expect(first.observation.observationId).toMatch(/^obs-/)
    h.advance(10_000) // past the 4 s reuse window
    const second = await h.observation.capture({ reason: 'ask' })
    expect(second.observation.sequence).toBe(2)
    expect(second.observation.observationId).not.toBe(first.observation.observationId)
  })

  it('names the display that was really captured, not the one the cursor asked for', async () => {
    const h = makeHarness()
    h.state.capturedDisplay = 11
    h.state.mismatch = true
    const shot = await h.observation.capture({ reason: 'ask' })
    expect(shot.displayMismatch).toBe(true)
    expect(shot.dispId).toBe(11)
    expect(shot.observation.sourceId).toBe('display:11')
  })

  it('keeps refusing an UNFLAGGED display drift as a hard failure', async () => {
    const h = makeHarness()
    h.state.capturedDisplay = 11
    await expect(h.observation.capture({ reason: 'ask' })).rejects.toThrow(/different display/i)
  })

  it('captures a region of the display, names it in the source id and never reuses it for a later turn', async () => {
    const h = makeHarness()
    const region = { x: 0.1, y: 0.25, width: 0.5, height: 0.5 }
    const shot = await h.observation.capture({ reason: 'ask', scope: { kind: 'region', region } })
    expect(h.calls).toEqual([{ displayId: 7, region }])
    expect(shot.observation).toMatchObject({ scope: 'region', sourceId: 'display:7/region:0.1,0.25,0.5,0.5' })
    await h.observation.capture({ reason: 'ask', scope: { kind: 'region', region } })
    expect(h.calls).toHaveLength(2) // a region is per turn: no cache
    const full = await h.observation.capture({ reason: 'ask' })
    expect(full.observation.scope).toBe('display')
    expect(h.calls[2]).toEqual({ displayId: 7 })
  })

  it('does not let a region capture fill the whole-display cache', async () => {
    const h = makeHarness()
    await h.observation.capture({
      reason: 'ask',
      scope: { kind: 'region', region: { x: 0, y: 0, width: 0.5, height: 0.5 } }
    })
    await h.observation.capture({ reason: 'ask' })
    expect(h.calls).toHaveLength(2)
    expect(h.calls[1].region).toBeUndefined()
  })

  it('refuses a window scope with a typed refusal until a window can be captured for real', async () => {
    const h = makeHarness()
    const error = await h.observation
      .capture({ reason: 'ask', scope: { kind: 'window', windowId: 'window:42:0' } })
      .catch((e) => e)
    expect(error).toBeInstanceOf(ScreenObservationRefusedError)
    expect(error.code).toBe('scope-unsupported')
    expect(h.captureOnce).not.toHaveBeenCalled()
  })

  it('reuses a fresh frame (same identity) inside the reuse window and captures again after it', async () => {
    const h = makeHarness()
    const a = await h.observation.capture({ reason: 'prewarm' })
    h.advance(3_900)
    const b = await h.observation.capture({ reason: 'ask' })
    expect(h.captureOnce).toHaveBeenCalledTimes(1)
    expect(b.observation).toEqual(a.observation)
    expect(b.capturedAt).toBe(a.capturedAt)
    h.advance(200)
    const c = await h.observation.capture({ reason: 'ask' })
    expect(h.captureOnce).toHaveBeenCalledTimes(2)
    expect(c.observation.sequence).toBe(2)
  })

  it('does not reuse a frame of one display for a cursor on another', async () => {
    const h = makeHarness()
    await h.observation.capture({ reason: 'ask' })
    h.state.cursorDisplay = 9
    const other = await h.observation.capture({ reason: 'ask' })
    expect(other.observation.sourceId).toBe('display:9')
    expect(h.captureOnce).toHaveBeenCalledTimes(2)
  })

  it('shares one native capture between two simultaneous requests for the same display and generation', async () => {
    const h = makeHarness()
    h.state.defer = true
    const a = h.observation.capture({ reason: 'prewarm' })
    const b = h.observation.capture({ reason: 'ask' })
    await tick()
    h.release()
    const [shotA, shotB] = await Promise.all([a, b])
    expect(h.captureOnce).toHaveBeenCalledTimes(1)
    expect(shotA.image).toBe(shotB.image)
  })
})

describe('generation is monotonic and every revocation moves it (G16)', () => {
  const reasons: ScreenRevocationReason[] = [
    'permission-revoked',
    'private-view',
    'signed-out',
    'screen-locked',
    'suspended',
    'session-ended',
    'display-removed'
  ]

  it('never decreases and returns the new value from revoke()', () => {
    const h = makeHarness()
    const seen: number[] = [h.observation.generation()]
    for (const reason of reasons) seen.push(h.observation.revoke(reason))
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(h.observation.generation()).toBe(7)
  })

  it('audits each revocation with its reason and the new generation, and nothing else', () => {
    const h = makeHarness()
    h.observation.revoke('signed-out')
    expect(h.audits).toEqual([{ event: 'capture.revoked', data: { reason: 'signed-out', generation: 1 } }])
  })

  it('drops the reusable frame, so the next ask takes a new capture under the new generation', async () => {
    const h = makeHarness()
    const before = await h.observation.capture({ reason: 'ask' })
    h.observation.revoke('session-ended')
    const after = await h.observation.capture({ reason: 'ask' })
    expect(h.captureOnce).toHaveBeenCalledTimes(2)
    expect(before.observation.generation).toBe(0)
    expect(after.observation.generation).toBe(1)
    expect(after.observation.sequence).toBeGreaterThan(before.observation.sequence)
  })
})

describe('a capture that was pending when access was revoked is dropped, never returned (G16)', () => {
  type Trigger = (h: ReturnType<typeof makeHarness>) => void
  const triggers: Array<[string, Trigger]> = [
    ['sign-out', (h) => void h.observation.revoke('signed-out')],
    ['the session ending', (h) => void h.observation.revoke('session-ended')],
    ['a display being removed', (h) => void h.observation.revoke('display-removed')],
    ['the screen locking', (h) => h.observation.noteScreenLocked(true)],
    ['the machine suspending', (h) => h.observation.noteSuspended(true)],
    [
      'Screen Recording being revoked',
      (h) => {
        h.state.access = 'denied'
        h.observation.reconcile()
      }
    ]
  ]

  for (const [name, trigger] of triggers) {
    it(`${name} drops the pending capture and its result`, async () => {
      const h = makeHarness()
      h.observation.reconcile() // the grant was observed before the revocation
      h.state.defer = true
      const pending = h.observation.capture({ reason: 'ask' })
      const settled = pending.catch((e) => e)
      await tick()
      trigger(h)
      h.release()
      const error = await settled
      expect(error).toBeInstanceOf(ScreenObservationRefusedError)
      expect(error.code).toBe('stale')
      expect(h.audits.some((a) => a.event === 'capture.dropped' && a.data?.reason === 'stale_generation')).toBe(true)
      // The dropped frame is not remembered: it cannot be sent later either.
      expect(h.observation.checkSend('synthetic-frame-1')).toEqual({ ok: true, known: false })
    })
  }

  it('turning Private View on mid-capture drops it with the Private View wording, whether or not settings reconciled', async () => {
    for (const reconcile of [false, true]) {
      const h = makeHarness()
      h.observation.reconcile()
      h.state.defer = true
      const settled = h.observation.capture({ reason: 'ask' }).catch((e) => e)
      await tick()
      h.state.privateView = true
      if (reconcile) h.observation.reconcile()
      h.release()
      const error = await settled
      expect(error).toBeInstanceOf(PrivateViewError)
    }
  })

  it('a request that arrives after the revocation does not ride the pre-revocation capture', async () => {
    const h = makeHarness()
    h.state.defer = true
    const stale = h.observation.capture({ reason: 'ask' }).catch((e) => e)
    await tick()
    h.observation.revoke('session-ended')
    const fresh = h.observation.capture({ reason: 'ask' })
    await tick()
    h.release()
    expect(await stale).toBeInstanceOf(ScreenObservationRefusedError)
    const shot = await fresh
    expect(h.captureOnce).toHaveBeenCalledTimes(2)
    expect(shot.observation.generation).toBe(1)
    expect(shot.image).toBe('synthetic-frame-2')
  })

  it('does not cache a dropped frame', async () => {
    const h = makeHarness()
    h.state.defer = true
    const settled = h.observation.capture({ reason: 'ask' }).catch((e) => e)
    await tick()
    h.observation.revoke('signed-out')
    h.release()
    await settled
    h.state.defer = false
    await h.observation.capture({ reason: 'ask' })
    expect(h.captureOnce).toHaveBeenCalledTimes(2)
  })
})

describe('what revokes, and what does not (G16)', () => {
  it('Screen Recording going from granted to denied or restricted revokes once', () => {
    const h = makeHarness()
    h.observation.reconcile()
    h.state.access = 'denied'
    h.observation.reconcile()
    h.observation.reconcile()
    expect(h.observation.generation()).toBe(1)
    expect(h.audits.filter((a) => a.event === 'capture.revoked')).toEqual([
      { event: 'capture.revoked', data: { reason: 'permission-revoked', generation: 1 } }
    ])
    h.state.access = 'granted'
    h.observation.reconcile()
    h.state.access = 'restricted'
    h.observation.reconcile()
    expect(h.observation.generation()).toBe(2)
  })

  it('a permission that was never granted, or is merely undetermined or unknown, revokes nothing', () => {
    const h = makeHarness({ access: 'not-determined' })
    h.observation.reconcile()
    h.state.access = 'denied'
    h.observation.reconcile()
    h.state.access = 'unknown'
    h.observation.reconcile()
    expect(h.observation.generation()).toBe(0)
  })

  it('permissionGranted() answers from the same read that detects the revocation', () => {
    const h = makeHarness()
    expect(h.observation.permissionGranted()).toBe(true)
    h.state.access = 'denied'
    expect(h.observation.permissionGranted()).toBe(false)
    expect(h.observation.generation()).toBe(1)
  })

  it('Private View turning on revokes; staying on or turning off does not', () => {
    const h = makeHarness()
    h.observation.reconcile()
    h.state.privateView = true
    h.observation.reconcile()
    expect(h.observation.generation()).toBe(1)
    h.observation.reconcile()
    expect(h.observation.generation()).toBe(1)
    h.state.privateView = false
    h.observation.reconcile()
    expect(h.observation.generation()).toBe(1)
  })

  it('lock and suspend revoke only when they begin, and unlock and resume revoke nothing', () => {
    const h = makeHarness()
    h.observation.noteScreenLocked(true)
    h.observation.noteScreenLocked(true)
    expect(h.observation.generation()).toBe(1)
    h.observation.noteScreenLocked(false)
    h.observation.noteSuspended(true)
    expect(h.observation.generation()).toBe(2)
    h.observation.noteSuspended(false)
    expect(h.observation.generation()).toBe(2)
  })
})

describe('Métis never captures while idle (G16)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('an hour of nothing makes zero capture calls and zero permission reads that capture', async () => {
    const h = makeHarness()
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(h.captureOnce).not.toHaveBeenCalled()
    expect(h.audits).toEqual([])
    expect(h.observation.generation()).toBe(0)
  })

  it('every lifecycle signal (lock, unlock, suspend, resume, revoke, reconcile) on its own captures nothing', async () => {
    const h = makeHarness()
    h.observation.reconcile()
    h.observation.noteScreenLocked(true)
    h.observation.noteScreenLocked(false)
    h.observation.noteSuspended(true)
    h.observation.noteSuspended(false)
    h.observation.revoke('signed-out')
    h.observation.permissionGranted()
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(h.captureOnce).not.toHaveBeenCalled()
  })

  it('refuses a capture that names no admitted trigger', async () => {
    const h = makeHarness()
    for (const reason of ['', 'hover', 'timer', 'idle', undefined, 'ASK', 'bg-screen'] as unknown as string[]) {
      const error = await h.observation.capture({ reason }).catch((e) => e)
      expect(error).toBeInstanceOf(ScreenObservationRefusedError)
      expect(error.code).toBe('idle')
    }
    expect(h.captureOnce).not.toHaveBeenCalled()
  })

  it('admits exactly the four triggers: ask, prewarm, check and (opted in) background', async () => {
    const h = makeHarness()
    for (const reason of ['ask', 'prewarm', 'check', 'background'] as const) {
      h.advance(10_000)
      await h.observation.capture({ reason })
    }
    expect(h.captureOnce).toHaveBeenCalledTimes(4)
  })

  it('a hover pre-capture is refused unless the explicit opt-in is on; an Ask still captures (R-11)', async () => {
    const h = makeHarness({ prewarm: false })
    const error = await h.observation.capture({ reason: 'prewarm', phase: 'prewarm' }).catch((e) => e)
    expect(error).toBeInstanceOf(ScreenObservationRefusedError)
    expect(error.code).toBe('prewarm-off')
    expect(h.captureOnce).not.toHaveBeenCalled()
    expect(h.audits).toEqual([])
    await h.observation.capture({ reason: 'ask' })
    expect(h.captureOnce).toHaveBeenCalledTimes(1)
    h.state.prewarm = true
    h.advance(10_000)
    await h.observation.capture({ reason: 'prewarm', phase: 'prewarm' })
    expect(h.captureOnce).toHaveBeenCalledTimes(2)
  })

  it('a background capture needs the opt-in setting at the moment it is requested', async () => {
    const h = makeHarness({ background: false })
    const error = await h.observation.capture({ reason: 'background' }).catch((e) => e)
    expect(error).toBeInstanceOf(ScreenObservationRefusedError)
    expect(error.code).toBe('background-off')
    expect(h.captureOnce).not.toHaveBeenCalled()
    h.state.background = true
    await h.observation.capture({ reason: 'background' })
    expect(h.captureOnce).toHaveBeenCalledTimes(1)
  })

  it('refuses every trigger while the screen is locked or the machine is suspended, then recovers', async () => {
    const h = makeHarness()
    h.observation.noteScreenLocked(true)
    for (const reason of ['ask', 'prewarm', 'check', 'background'] as const) {
      const error = await h.observation.capture({ reason }).catch((e) => e)
      expect(error.code).toBe('locked')
    }
    expect(h.captureOnce).not.toHaveBeenCalled()
    h.observation.noteScreenLocked(false)
    h.observation.noteSuspended(true)
    expect((await h.observation.capture({ reason: 'ask' }).catch((e) => e)).code).toBe('locked')
    h.observation.noteSuspended(false)
    await h.observation.capture({ reason: 'ask' })
    expect(h.captureOnce).toHaveBeenCalledTimes(1)
  })

  it('Private View refuses every trigger without touching the capture, and a prewarm leaves no audit trail', async () => {
    const h = makeHarness()
    h.state.privateView = true
    for (const reason of ['ask', 'prewarm', 'check', 'background'] as const) {
      await expect(h.observation.capture({ reason })).rejects.toBeInstanceOf(PrivateViewError)
    }
    expect(h.captureOnce).not.toHaveBeenCalled()
    const blocked = h.audits.filter((a) => a.event === 'capture.blocked')
    expect(blocked).toHaveLength(3) // ask, check and background; the prewarm is silent
    expect(blocked.every((a) => a.data?.reason === 'private_view')).toBe(true)
  })

  it('maps the legacy phase strings onto triggers and leaves anything else unadmitted', () => {
    expect(captureReasonForPhase(undefined)).toBe('ask')
    expect(captureReasonForPhase('prewarm')).toBe('prewarm')
    expect(captureReasonForPhase('screen-check')).toBe('check')
    expect(captureReasonForPhase('bg-screen')).toBe('background')
    expect(captureReasonForPhase('hover')).toBeNull()
    expect(captureReasonForPhase('')).toBeNull()
  })
})

describe('a captured frame cannot be sent after access was revoked (G16)', () => {
  it('lets a current frame through and says it recognised it', async () => {
    const h = makeHarness()
    const shot = await h.observation.capture({ reason: 'ask' })
    expect(h.observation.checkSend(shot.image)).toEqual({ ok: true, known: true })
  })

  it('refuses the frame once any revocation has moved the generation', async () => {
    const h = makeHarness()
    const shot = await h.observation.capture({ reason: 'ask' })
    h.observation.revoke('screen-locked')
    const verdict = h.observation.checkSend(shot.image)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.reason).toBe('stale')
      expect(verdict.message).toMatch(/capture the screen again/i)
    }
  })

  it('notices a Screen Recording grant withdrawn without any event at the moment of sending', async () => {
    const h = makeHarness()
    const shot = await h.observation.capture({ reason: 'ask' })
    h.state.access = 'denied'
    expect(h.observation.checkSend(shot.image).ok).toBe(false)
    expect(h.observation.generation()).toBe(1)
  })

  it('says nothing about an image it never issued, so it cannot block a frame it does not own', () => {
    const h = makeHarness()
    expect(h.observation.checkSend('synthetic-not-ours')).toEqual({ ok: true, known: false })
  })

  it('remembers a bounded number of frames', async () => {
    const h = makeHarness()
    const first = await h.observation.capture({ reason: 'ask' })
    for (let i = 0; i < 20; i++) {
      h.advance(10_000)
      await h.observation.capture({ reason: 'ask' })
    }
    expect(h.observation.checkSend(first.image)).toEqual({ ok: true, known: false })
  })

  it('never writes pixels, transcript text or provider content into an audit record', async () => {
    const h = makeHarness()
    const shot = await h.observation.capture({ reason: 'ask' })
    h.observation.revoke('signed-out')
    h.state.defer = true
    const settled = h.observation.capture({ reason: 'ask' }).catch((e) => e)
    await tick()
    h.observation.revoke('session-ended')
    h.release()
    await settled
    expect(JSON.stringify(h.audits)).not.toContain(shot.image)
    expect(JSON.stringify(h.audits)).not.toContain('synthetic-frame')
  })
})

describe('failure audit', () => {
  it('audits a failed real capture but not a failed prewarm', async () => {
    const h = makeHarness()
    h.captureOnce.mockRejectedValueOnce(new Error('Screen Recording permission is off for Métis.'))
    await expect(h.observation.capture({ reason: 'ask' })).rejects.toThrow(/permission is off/)
    h.captureOnce.mockRejectedValueOnce(new Error('boom'))
    await expect(h.observation.capture({ reason: 'prewarm' })).rejects.toThrow(/boom/)
    expect(h.audits.filter((a) => a.event === 'capture.failed')).toHaveLength(1)
  })

  it('audits a successful capture with size and phase only', async () => {
    const h = makeHarness()
    await h.observation.capture({ reason: 'check', phase: 'screen-check' })
    expect(h.audits).toEqual([
      {
        event: 'capture.screen',
        data: { width: 1280, height: 800, bytes: 'synthetic-frame-1'.length, phase: 'screen-check' }
      }
    ])
  })
})
