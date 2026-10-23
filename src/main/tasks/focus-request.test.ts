import { describe, expect, it, vi } from 'vitest'
import type { DesktopActionRequest } from '@shared/desktop-actions'
import type { EscapeRelease, ForegroundHold } from './escape-release'
import { FOCUS_REFUSAL_COPY, createFocusRequestStep, type FocusRequestDeps } from './focus-request'

const REQUEST: DesktopActionRequest = { id: 'desktop.photo_booth_capture', args: {} }

function build(overrides: Partial<FocusRequestDeps> = {}) {
  const order: string[] = []
  const hold: ForegroundHold = { end: vi.fn(), escaped: new Promise(() => undefined) }
  const escape: EscapeRelease = {
    hold: vi.fn((spec) => {
      order.push('arm')
      void spec
      return hold
    })
  }
  const audit = vi.fn()
  const deps: FocusRequestDeps = {
    capturePrevious: vi.fn(() => void order.push('capture')),
    restoreFocus: vi.fn(async () => undefined),
    preflight: vi.fn(async () => (order.push('preflight'), { ok: true as const })),
    decide: vi.fn(async () => (order.push('decide'), 'granted' as const)),
    grantMaySkip: () => false,
    escape,
    audit,
    ...overrides
  }
  return { step: createFocusRequestStep(deps), deps, escape, hold, audit, order }
}
const input = (extra: { viaGrant?: boolean } = {}) => ({
  viaGrant: extra.viaGrant ?? false,
  signal: new AbortController().signal,
  stop: vi.fn()
})

describe('focus-request step (G40)', () => {
  it('remembers the previous app, preflights, asks, and only then arms Escape control', async () => {
    const h = build()
    const result = await h.step.run(REQUEST, input())
    expect(result).toEqual({ ok: true, hold: h.hold })
    expect(h.order).toEqual(['capture', 'preflight', 'decide', 'arm'])
    expect(h.audit).toHaveBeenCalledWith(
      'task.focus_requested',
      expect.objectContaining({ actionId: 'desktop.photo_booth_capture', decision: 'granted', viaGrant: 'no' })
    )
  })

  it('refuses with its own copy when the person declines, and never arms control', async () => {
    const h = build({ decide: vi.fn(async () => 'declined' as const) })
    const result = await h.step.run(REQUEST, input())
    expect(result).toEqual({ ok: false, reason: 'focus_declined', copy: FOCUS_REFUSAL_COPY.focus_declined })
    expect(h.escape.hold).not.toHaveBeenCalled()
    expect(h.audit).toHaveBeenCalledWith('task.focus_requested', expect.objectContaining({ decision: 'declined' }))
  })

  it('a grant does not skip the decision by default', async () => {
    const h = build({ decide: vi.fn(async () => 'declined' as const) })
    const result = await h.step.run(REQUEST, input({ viaGrant: true }))
    expect(h.deps.decide).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ok: false, reason: 'focus_declined' })
  })

  it('skips the decision for a grant only when the owner policy explicitly allows it, and says so', async () => {
    const h = build({ grantMaySkip: () => true })
    expect((await h.step.run(REQUEST, input({ viaGrant: true }))).ok).toBe(true)
    expect(h.deps.decide).not.toHaveBeenCalled()
    expect(h.audit).toHaveBeenCalledWith(
      'task.focus_requested',
      expect.objectContaining({ decision: 'skipped_by_owner_policy', viaGrant: 'yes' })
    )
    // Policy allowance alone is not enough: an approval card is not a grant.
    const h2 = build({ grantMaySkip: () => true })
    await h2.step.run(REQUEST, input({ viaGrant: false }))
    expect(h2.deps.decide).toHaveBeenCalledTimes(1)
  })

  it('refuses before asking when the permission preflight fails', async () => {
    const h = build({
      preflight: vi.fn(async () => ({
        ok: false as const,
        code: 'accessibility_needed',
        copy: 'Métis needs Accessibility.'
      }))
    })
    const result = await h.step.run(REQUEST, input())
    expect(result).toEqual({ ok: false, reason: 'focus_preflight_failed', copy: 'Métis needs Accessibility.' })
    expect(h.deps.decide).not.toHaveBeenCalled()
  })

  it('refuses control that cannot be given back: no Escape means no foreground', async () => {
    const h = build()
    ;(h.escape.hold as ReturnType<typeof vi.fn>).mockReturnValue(null)
    const result = await h.step.run(REQUEST, input())
    expect(result).toEqual({ ok: false, reason: 'escape_unavailable', copy: FOCUS_REFUSAL_COPY.escape_unavailable })
  })

  it('a decision that cannot be asked or throws is a refusal, never a grant', async () => {
    const h = build({ decide: vi.fn(async () => Promise.reject(new Error('no window'))) })
    expect(await h.step.run(REQUEST, input())).toMatchObject({ ok: false, reason: 'focus_unavailable' })
  })

  it('a stop during the decision wins over a late yes', async () => {
    const controller = new AbortController()
    const h = build({
      decide: vi.fn(async () => {
        controller.abort()
        return 'granted' as const
      })
    })
    const result = await h.step.run(REQUEST, { viaGrant: false, signal: controller.signal, stop: vi.fn() })
    expect(result).toMatchObject({ ok: false, reason: 'focus_stopped' })
    expect(h.escape.hold).not.toHaveBeenCalled()
  })

  it('never puts request arguments or app titles into the audit record', async () => {
    const h = build()
    await h.step.run({ id: 'desktop.photo_booth_capture', args: {} }, input())
    for (const [, metadata] of h.audit.mock.calls) {
      expect(Object.keys(metadata as object).sort()).toEqual(['actionId', 'decision', 'viaGrant'])
    }
  })
})
