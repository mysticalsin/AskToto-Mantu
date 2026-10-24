import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ROUTINE_AVAILABILITY_COPY, type CompileResult, type RoutineView } from '@shared/routines'
import { RoutinesListView } from './RoutinesSection'
import { ConsentCard } from './RoutineEditor'
import { createFromPreview, deleteWithConfirm, resumeWithReconcile, runNowWithConfirm } from './routine-actions'
import { formatWhen } from './routine-copy'

const NOW = Date.UTC(2026, 9, 24, 12, 0)
type Compiled = Extract<CompileResult, { ok: true }>

function routineView(over: Partial<RoutineView> = {}): RoutineView {
  return {
    routineId: 'r_0123456789abcdef01234567',
    assistantId: 'a_0123456789abcdef01234567',
    title: 'Morning brief',
    purpose: 'reminder',
    consentKind: 'recurring',
    schedule: { kind: 'recurring', cadence: 'weekdays', time: '09:00', timeZone: 'America/Sao_Paulo' },
    copy: 'Every weekday 09:00',
    status: 'active',
    pauseReasons: [],
    waiting: null,
    failures: 0,
    lastErrorClass: null,
    nextDueAt: NOW + 3_600_000,
    quotaResetAt: null,
    history: [],
    availability: { runner: 'running', copy: ROUTINE_AVAILABILITY_COPY },
    ...over
  }
}

function compiled(over: Partial<Compiled['preview']> = {}, expiresAt = NOW + 60_000): Compiled {
  return {
    ok: true,
    proposalId: 'p_fixture',
    previewHash: 'h_fixture',
    expiresAt,
    preview: {
      assistantId: 'a_0123456789abcdef01234567',
      purpose: 'reminder',
      title: 'Morning brief',
      consentKind: 'recurring',
      schedule: { kind: 'recurring', cadence: 'weekdays', time: '09:00', timeZone: 'America/Sao_Paulo' },
      tools: ['web.search'],
      copy: 'Every weekday 09:00 Sao Paulo',
      nextRuns: [NOW + 1, NOW + 2, NOW + 3],
      ...over
    }
  }
}

const handlers = { onPause: vi.fn(), onResume: vi.fn(), onRunNow: vi.fn(), onDelete: vi.fn() }
const list = (routines: RoutineView[]) =>
  renderToStaticMarkup(createElement(RoutinesListView, { state: { kind: 'ready', routines }, now: NOW, ...handlers }))

function api(over: Record<string, unknown> = {}) {
  const ok = { ok: true, routine: null } as const
  return {
    list: vi.fn(),
    compile: vi.fn(),
    consent: vi.fn(async () => ({ ok: true, routine: routineView(), created: true }) as const),
    pause: vi.fn(async () => ok),
    resume: vi.fn(async () => ok),
    runNow: vi.fn(async () => ok),
    remove: vi.fn(async () => ok),
    onChanged: vi.fn(() => () => {}),
    onResult: vi.fn(() => () => {}),
    ...over
  } as unknown as Window['toto']['routines']
}

describe('routines section (G69)', () => {
  it('renders unavailable state when bridge refuses', () => {
    const html = renderToStaticMarkup(
      createElement(RoutinesListView, { state: { kind: 'refused', reason: 'unavailable' }, now: NOW, ...handlers })
    )
    expect(html).toContain('Routines are not available right now')
  })

  it('row exposes Pause, Run now, Delete with titled aria-labels', () => {
    const html = list([routineView()])
    expect(html).toContain('role="listitem"')
    expect(html).toContain('aria-label="Pause Morning brief"')
    expect(html).toContain('aria-label="Run Morning brief now"')
    expect(html).toContain('aria-label="Delete Morning brief"')
    expect(html).toContain(ROUTINE_AVAILABILITY_COPY)
    expect(html).toContain(`Next run ${formatWhen(NOW + 3_600_000)}`)
    expect(html.toLowerCase()).not.toContain('always on')
  })

  it('paused row shows Resume', () => {
    const html = list([routineView({ pauseReasons: ['user'] })])
    expect(html).toContain('aria-label="Resume Morning brief"')
    expect(html).not.toContain('aria-label="Pause Morning brief"')
  })

  it('consent card shows preview copy, next runs, Runs once versus Repeats', () => {
    const repeat = renderToStaticMarkup(
      createElement(ConsentCard, { compiled: compiled(), now: NOW, busy: false, onCreate: vi.fn(), onBack: vi.fn() })
    )
    expect(repeat).toContain('Every weekday 09:00 Sao Paulo')
    for (const at of [NOW + 1, NOW + 2, NOW + 3]) expect(repeat).toContain(formatWhen(at))
    expect(repeat).toContain('Repeats')
    expect(repeat).toContain('Search the web')
    const once = renderToStaticMarkup(
      createElement(ConsentCard, {
        compiled: compiled({ consentKind: 'once', nextRuns: [NOW + 1], tools: [] }),
        now: NOW,
        busy: false,
        onCreate: vi.fn(),
        onBack: vi.fn()
      })
    )
    expect(once).toContain('Runs once')
    expect(once).not.toContain('Repeats')
  })

  it('expired preview disables Create', () => {
    const html = renderToStaticMarkup(
      createElement(ConsentCard, {
        compiled: compiled({}, NOW - 1),
        now: NOW,
        busy: false,
        onCreate: vi.fn(),
        onBack: vi.fn()
      })
    )
    expect(html).toContain('Preview expired. Preview again.')
    expect(html.match(/<button\b[^>]*>Create<\/button>/)?.[0]).toMatch(/\sdisabled(?:=|>)/)
  })

  it('Create sends proposalId and previewHash unchanged', async () => {
    const bridge = api()
    const result = await createFromPreview(bridge, compiled(), NOW)
    expect(bridge.consent).toHaveBeenCalledWith('p_fixture', 'h_fixture')
    expect(result.ok).toBe(true)
    const late = api()
    expect(await createFromPreview(late, compiled({}, NOW - 1), NOW)).toEqual({ ok: false, reason: 'expired' })
    expect(late.consent).not.toHaveBeenCalled()
  })

  it('reconciliation_required resume asks then sends reconciled true', async () => {
    const resume = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'reconciliation_required' })
      .mockResolvedValueOnce({ ok: true, routine: null })
    const bridge = api({ resume })
    const confirm = vi.fn(async () => true)
    const result = await resumeWithReconcile(bridge, confirm, routineView({ pauseReasons: ['user'] }))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(resume.mock.calls).toEqual([['r_0123456789abcdef01234567'], ['r_0123456789abcdef01234567', true]])
    expect(result).toEqual({ ok: true, routine: null })

    const declined = vi.fn().mockResolvedValueOnce({ ok: false, reason: 'reconciliation_required' })
    expect(await resumeWithReconcile(api({ resume: declined }), async () => false, routineView())).toBeNull()
    expect(declined).toHaveBeenCalledTimes(1)
  })

  it('delete goes through confirm', async () => {
    const bridge = api()
    const confirm = vi.fn(async () => false)
    expect(await deleteWithConfirm(bridge, confirm, routineView())).toBeNull()
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ destructive: true }))
    expect(bridge.remove).not.toHaveBeenCalled()
    await deleteWithConfirm(bridge, async () => true, routineView())
    expect(bridge.remove).toHaveBeenCalledWith('r_0123456789abcdef01234567')
  })

  it('run now confirms only a scheduled task', async () => {
    const bridge = api()
    const confirm = vi.fn(async () => true)
    await runNowWithConfirm(bridge, confirm, routineView({ purpose: 'reminder' }))
    expect(confirm).not.toHaveBeenCalled()
    await runNowWithConfirm(bridge, confirm, routineView({ purpose: 'scheduled_task' }))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(bridge.runNow).toHaveBeenCalledTimes(2)
  })
})
