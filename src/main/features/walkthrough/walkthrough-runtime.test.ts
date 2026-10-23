import { describe, expect, it } from 'vitest'
import { WalkthroughViewSchema } from '@shared/walkthrough-view'
import { createWalkthroughRuntime, type WalkthroughRuntimeDeps } from './walkthrough-runtime'

const PLAN = {
  app: 'notes',
  steps: [
    {
      instruction: 'Open the Format menu',
      postcondition: { kind: 'element', role: 'menu', name: 'Format', state: 'open' }
    },
    { instruction: 'Choose Font', postcondition: { kind: 'window', titleContains: 'Fonts' } }
  ]
}

function make(options: Partial<WalkthroughRuntimeDeps> & { planned?: unknown } = {}) {
  let sequence = 0
  const screen = { elements: [] as Array<{ role: string; name?: string; state?: string }>, title: 'Notes' }
  const audits: Array<{ event: string; data: Record<string, string | number> }> = []
  const views: unknown[] = []
  let meeting = false
  const runtime = createWalkthroughRuntime({
    enabled: () => true,
    ownerKey: () => 'wc:1',
    meetingActive: () => meeting,
    observer: {
      watermark: () => ({ generation: 1, sequence }),
      observe: async () => ({
        generation: 1,
        sequence: ++sequence,
        capturedAt: Date.now() + 1,
        windowTitle: screen.title,
        elements: screen.elements
      })
    },
    planner: { plan: async () => ('planned' in options ? options.planned : PLAN) },
    setTimer: () => () => {},
    audit: (event, data) => audits.push({ event, data }),
    onView: (v) => views.push(v),
    ...options
  })
  return { runtime, screen, audits, views, setMeeting: (m: boolean) => (meeting = m) }
}

describe('walkthrough runtime (G44)', () => {
  it('is off by default for the caller: a disabled switch starts nothing', async () => {
    const h = make({ enabled: () => false })
    const r = await h.runtime.handle({ kind: 'start', goal: 'format text' })
    expect(r.status).toBe('disabled')
    expect(h.runtime.active()).toBe(false)
    expect(h.audits).toEqual([])
  })

  it('plans, guides and finishes on verified changes, producing renderer-safe views', async () => {
    const h = make()
    expect((await h.runtime.handle({ kind: 'start', goal: 'format text' })).status).toBe('started')
    expect(h.runtime.view()).toMatchObject({ phase: 'awaiting', step: 1, stepCount: 2 })
    expect((await h.runtime.handle({ kind: 'check' })).status).toBe('retry')
    h.screen.elements = [{ role: 'menu', name: 'Format', state: 'open' }]
    expect((await h.runtime.handle({ kind: 'check' })).status).toBe('advanced')
    h.screen.title = 'Fonts'
    expect((await h.runtime.handle({ kind: 'check' })).status).toBe('completed')
    for (const v of h.views) expect(WalkthroughViewSchema.safeParse(v).success).toBe(true)
    expect(h.runtime.active()).toBe(false)
  })

  it('says it cannot guide when no planner is bound or the planner has no plan, and touches nothing', async () => {
    const none = make({ planner: undefined })
    expect((await none.runtime.handle({ kind: 'start', goal: 'x' })).status).toBe('no_plan')
    expect(none.runtime.view()).toMatchObject({ phase: 'abandoned', stopReason: 'no_plan' })
    const empty = make({ planned: null })
    expect((await empty.runtime.handle({ kind: 'start', goal: 'x' })).status).toBe('no_plan')
    const bad = make({
      planned: { steps: [{ instruction: 'x', postcondition: { kind: 'free-text', text: 'do it' } }] }
    })
    expect((await bad.runtime.handle({ kind: 'start', goal: 'x' })).status).toBe('no_plan')
    expect(bad.runtime.view().stopReason).toBe('plan_refused')
  })

  it('refuses to start during a meeting or without an owner window', async () => {
    const h = make()
    h.setMeeting(true)
    expect((await h.runtime.handle({ kind: 'start', goal: 'x' })).status).toBe('meeting')
    const o = make({ ownerKey: () => null })
    expect((await o.runtime.handle({ kind: 'start', goal: 'x' })).status).toBe('no_owner')
  })

  it('a live walkthrough is busy for a second start; stop frees it', async () => {
    const h = make()
    await h.runtime.handle({ kind: 'start', goal: 'x' })
    expect((await h.runtime.handle({ kind: 'start', goal: 'y' })).status).toBe('busy')
    expect((await h.runtime.handle({ kind: 'stop' })).status).toBe('stopped')
    expect((await h.runtime.handle({ kind: 'start', goal: 'y' })).status).toBe('started')
  })

  it('pause then resume revalidates against a fresh look and refuses to resume into a meeting', async () => {
    const h = make()
    await h.runtime.handle({ kind: 'start', goal: 'x' })
    expect((await h.runtime.handle({ kind: 'pause' })).status).toBe('paused')
    h.setMeeting(true)
    expect((await h.runtime.handle({ kind: 'resume' })).status).toBe('blocked')
    h.setMeeting(false)
    h.screen.elements = [{ role: 'menu', name: 'Format', state: 'open' }] // done while paused
    expect((await h.runtime.handle({ kind: 'resume' })).status).toBe('advanced')
  })

  it('a changed owner window abandons the previous walkthrough', async () => {
    let owner = 'wc:1'
    const h = make({ ownerKey: () => owner })
    await h.runtime.handle({ kind: 'start', goal: 'x' })
    owner = 'wc:2'
    await h.runtime.handle({ kind: 'check' })
    expect(h.runtime.view()).toMatchObject({ phase: 'abandoned', stopReason: 'owner_switch' })
  })

  it('stop during planning drops the plan that arrives afterwards', async () => {
    let resolve!: (plan: unknown) => void
    const h = make({ planner: { plan: () => new Promise((r) => (resolve = r)) } })
    const started = h.runtime.handle({ kind: 'start', goal: 'x' })
    await Promise.resolve()
    h.runtime.stop('owner_stop')
    resolve(PLAN)
    expect((await started).status).toBe('stopped')
    expect(h.runtime.view().phase).toBe('abandoned')
  })

  it('audits metadata only: no goal, instruction or screen text', async () => {
    const h = make()
    await h.runtime.handle({ kind: 'start', goal: 'quarterly secret goal' })
    h.screen.title = 'confidential minutes'
    await h.runtime.handle({ kind: 'check' })
    await h.runtime.handle({ kind: 'stop' })
    const text = JSON.stringify(h.audits)
    expect(text).not.toContain('secret goal')
    expect(text).not.toContain('Format menu')
    expect(text).not.toContain('confidential')
    expect(h.audits.every((a) => a.event === 'walkthrough.event')).toBe(true)
    expect(h.audits.length).toBeGreaterThan(2)
  })
})
