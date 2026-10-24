import { describe, expect, it } from 'vitest'
import { createRoutineResearchPort } from './service'
import {
  DAY,
  HOUR,
  KEY_B,
  NOW,
  TENANT_2,
  fakeSource,
  harness,
  scopeOf,
  support
} from './__fixtures__/suggestions-harness'

type H = ReturnType<typeof harness>

async function oneCard(h: H, service: ReturnType<H['newService']>) {
  const check = await service.checkNow()
  expect(check).toMatchObject({ ok: true })
  const list = await service.list()
  if (!list.ok) throw new Error('list refused')
  const card = list.cards[0]!
  return { card, ref: { id: card.id, revision: card.revision, nonce: card.nonce } }
}

describe('suggestion service (G67)', () => {
  it('refuses checkNow, list and the routine port while suggestions are off (T082)', async () => {
    const h = harness()
    const service = h.newService()
    h.flags.enabled = false
    expect(await service.checkNow()).toEqual({ ok: false, reason: 'disabled' })
    expect(await service.list()).toEqual({ ok: false, reason: 'disabled' })
    expect(
      await createRoutineResearchPort(service)({ title: 'Prep', tools: [] }, new AbortController().signal)
    ).toEqual({
      ok: false,
      errorClass: 'disabled'
    })
    expect(h.calendar.calls + h.memory.calls).toBe(0)
  })

  it('refuses everything without a verified scope', async () => {
    const h = harness(null)
    const service = h.newService()
    expect(await service.checkNow()).toEqual({ ok: false, reason: 'signed-out' })
    expect(await service.list()).toEqual({ ok: false, reason: 'signed-out' })
  })

  it('a manual run builds one deduplicated card from both sources and never notifies (T084)', async () => {
    const h = harness()
    const service = h.newService()
    const result = await service.checkNow()
    expect(result).toMatchObject({ ok: true, created: 1, run: { state: 'succeeded', trigger: 'manual' } })
    const list = await service.list()
    expect(list.ok && list.cards).toHaveLength(1)
    expect(list.ok && list.cards[0]!.evidence.map((e) => e.sourceKind)).toEqual(['calendar', 'memory'])
    expect(h.notifications).toEqual([])
  })

  it('reads at most two sources at a time (T084)', async () => {
    const h = harness()
    const a = fakeSource('calendar', [])
    const b = fakeSource('memory', [])
    const c = fakeSource('memory', [])
    const gate = { active: 0, max: 0 }
    for (const source of [a, b, c]) {
      const inner = source.gather.bind(source)
      source.gather = async (ctx) => {
        gate.active += 1
        gate.max = Math.max(gate.max, gate.active)
        try {
          return await inner(ctx)
        } finally {
          gate.active -= 1
        }
      }
    }
    await h.newService([a, b, c]).checkNow()
    expect(gate.max).toBe(2)
  })

  it('lists cards in a stable order with the last shown id (A11)', async () => {
    const h = harness()
    h.calendar.items = [
      ...h.calendar.items,
      {
        role: 'anchor',
        evidence: {
          ...h.calendar.items[0]!.evidence,
          ref: { accountRef: 'acct_9', eventKey: 'ffffffff' },
          label: 'Roadmap sync',
          terms: ['roadmap', 'sync', 'launch']
        } as never
      }
    ]
    const service = h.newService()
    await service.checkNow()
    const list = await service.list()
    if (!list.ok) throw new Error('refused')
    expect(list.cards).toHaveLength(2)
    expect(list.cards.map((c) => c.id)).toEqual([...list.cards.map((c) => c.id)].sort())
    expect(list.lastShownId).toBeNull()
    const second = list.cards[1]!
    await service.shown({ id: second.id, revision: second.revision, nonce: second.nonce })
    const again = await service.list()
    expect(again.ok && again.lastShownId).toBe(second.id)
    expect(again.ok && again.cards.map((c) => c.id)).toEqual(list.cards.map((c) => c.id))
  })

  it('does not leak keys, fingerprints, refs or terms to the renderer view', async () => {
    const h = harness()
    const service = h.newService()
    await service.checkNow()
    const text = JSON.stringify(await service.list())
    for (const hidden of [
      'ownerKey',
      'tenantKey',
      'fingerprint',
      'evidenceDigest',
      'accountRef',
      'memoryId',
      'terms'
    ]) {
      expect(text).not.toContain(hidden)
    }
  })

  describe('accept and dismiss (T085, T086, T087)', () => {
    it('accepts the shown card and returns its sources', async () => {
      const h = harness()
      const service = h.newService()
      const { ref } = await oneCard(h, service)
      await service.shown(ref)
      const accepted = await service.accept(ref)
      expect(accepted).toEqual({ ok: true, sources: ['Budget review', 'Prefers forecast numbers first'] })
      const list = await service.list()
      expect(list.ok && list.cards).toHaveLength(0)
    })

    it('rejects a card that is not the last one shown, a wrong nonce, a stale revision and an unknown id', async () => {
      const h = harness()
      const service = h.newService()
      const { ref } = await oneCard(h, service)
      expect(await service.accept(ref)).toEqual({ ok: false, reason: 'stale' }) // offscreen: never shown
      await service.shown(ref)
      expect(await service.accept({ ...ref, nonce: 'e'.repeat(32) })).toEqual({ ok: false, reason: 'stale' })
      expect(await service.accept({ ...ref, revision: 2 })).toEqual({ ok: false, reason: 'stale' })
      expect(await service.dismiss({ ...ref, id: 'c'.repeat(24), reason: 'wrong' })).toEqual({
        ok: false,
        reason: 'stale'
      })
      expect(await service.accept(ref)).toMatchObject({ ok: true })
    })

    it('rejects an expired card', async () => {
      const h = harness()
      const service = h.newService()
      const { ref } = await oneCard(h, service)
      await service.shown(ref)
      h.clock.now += DAY + 1
      expect(await service.accept(ref)).toEqual({ ok: false, reason: 'stale' })
    })

    it('rejects a superseded card when the evidence set changed', async () => {
      const h = harness()
      const service = h.newService()
      const { ref } = await oneCard(h, service)
      await service.shown(ref)
      h.memory.items = [...h.memory.items, support(5, 'Wants the Q4 forecast', ['forecast', 'budget'])]
      await service.checkNow()
      expect(await service.accept(ref)).toEqual({ ok: false, reason: 'stale' })
      const list = await service.list()
      expect(list.ok && list.cards).toHaveLength(1)
      expect(list.ok && list.cards[0]!.evidence).toHaveLength(3)
    })

    it('keeps the same card when a rerun finds the same evidence', async () => {
      const h = harness()
      const service = h.newService()
      const { card } = await oneCard(h, service)
      const second = await service.checkNow()
      expect(second).toMatchObject({ ok: true, created: 0 })
      const list = await service.list()
      expect(list.ok && list.cards.map((c) => c.id)).toEqual([card.id])
    })

    it('re-checks every source at accept time; a revoked source returns sources_changed and accepts nothing', async () => {
      const h = harness()
      const service = h.newService()
      const { ref } = await oneCard(h, service)
      await service.shown(ref)
      h.memory.valid = false
      expect(await service.accept(ref)).toEqual({ ok: false, reason: 'sources_changed' })
      h.memory.valid = true
      expect(await service.accept(ref)).toEqual({ ok: false, reason: 'stale' }) // the card is now sources_changed, not open
      const list = await service.list()
      expect(list.ok && list.cards).toHaveLength(0)
    })

    it('dismiss records the reason and the same evidence does not come back (T087)', async () => {
      const h = harness()
      const service = h.newService()
      const { ref } = await oneCard(h, service)
      await service.shown(ref)
      expect(await service.dismiss({ ...ref, reason: 'not_useful' })).toEqual({ ok: true })
      expect(await service.checkNow()).toMatchObject({ ok: true, created: 0 })
      h.memory.items = [...h.memory.items, support(5, 'Wants the Q4 forecast', ['forecast', 'budget'])]
      expect(await service.checkNow()).toMatchObject({ ok: true, created: 1 })
    })
  })

  describe('adjust (T085)', () => {
    it('creates revision n+1 as a draft, keeps n until committed, and a cancel keeps the original', async () => {
      const h = harness()
      const service = h.newService()
      const { ref } = await oneCard(h, service)
      await service.shown(ref)
      const draft = await service.adjust({ ...ref, action: 'draft', title: 'Prep the forecast' })
      expect(draft).toMatchObject({ ok: true, revision: 2 })
      const during = await service.list()
      expect(during.ok && during.cards[0]).toMatchObject({ revision: 1, nonce: ref.nonce })
      expect(await service.adjust({ ...ref, action: 'cancel' })).toMatchObject({ ok: true })
      const after = await service.list()
      expect(after.ok && after.cards[0]).toMatchObject({ revision: 1, nonce: ref.nonce })
      await service.adjust({ ...ref, action: 'draft', title: 'Prep the forecast' })
      const committed = await service.adjust({ ...ref, action: 'commit' })
      expect(committed).toMatchObject({ ok: true, revision: 2 })
      const final = await service.list()
      const card = final.ok ? final.cards[0]! : null
      expect(card).toMatchObject({ revision: 2, title: 'Prep the forecast' })
      expect(card!.nonce).not.toBe(ref.nonce)
      expect(await service.accept(ref)).toEqual({ ok: false, reason: 'stale' })
    })
  })

  describe('runs (T090)', () => {
    it('reports queued, never failed, while the store is busy, and keeps source timing apart from queue age', async () => {
      const h = harness()
      const service = h.newService()
      let release!: () => void
      h.io.readGate = new Promise<void>((resolve) => (release = resolve))
      h.calendar.ms = 40
      const pending = service.checkNow()
      await Promise.resolve()
      expect(service.activeRun()).toMatchObject({ state: 'queued', enqueuedAt: NOW })
      expect(service.activeRun()?.startedAt).toBeUndefined()
      h.clock.now += 500 // the run waited in the queue
      h.io.readGate = null
      release()
      const result = await pending
      expect(result.ok && result.run).toMatchObject({ state: 'succeeded', enqueuedAt: NOW, startedAt: NOW + 500 })
      expect(result.ok && result.run.sourceMs?.calendar).toBe(40)
      expect(result.ok && Object.keys(result.run.sourceMs ?? {}).sort()).toEqual(['calendar', 'memory'])
      expect(result.ok && result.run.finishedAt).toBeGreaterThanOrEqual(NOW + 540)
    })

    it('a second request while one runs joins it', async () => {
      const h = harness()
      const service = h.newService()
      const [a, b] = await Promise.all([service.checkNow(), service.checkNow()])
      expect(a.ok && b.ok && a.run.runId).toBe(b.ok && b.run.runId)
      expect(h.calendar.calls).toBe(1)
    })

    it('fails only when every source fails; a skipped or failing minority still succeeds', async () => {
      const h = harness()
      h.memory.throws = true
      expect(await h.newService().checkNow()).toMatchObject({ ok: true, run: { state: 'succeeded' } })
      h.calendar.throws = true
      expect(await h.newService().checkNow()).toMatchObject({
        ok: true,
        run: { state: 'failed', errorClass: 'connector' }
      })
    })

    it('an owner switch mid-run aborts it and withholds its results', async () => {
      const h = harness()
      const service = h.newService()
      const inner = h.calendar.gather.bind(h.calendar)
      h.calendar.gather = async (ctx) => {
        const out = await inner(ctx)
        h.current.scope = scopeOf(KEY_B, TENANT_2)
        service.onOwnerChange()
        return out
      }
      const result = await service.checkNow()
      expect(result).toMatchObject({ ok: true, run: { state: 'cancelled' } })
      h.current.scope = scopeOf('a'.repeat(64), '1'.repeat(64))
      const list = await service.list()
      expect(list.ok && list.cards).toHaveLength(0)
    })
  })

  describe('routine port (T089, A9)', () => {
    const request = { title: 'Morning prep', tools: ['calendar.read'] }

    it('nudges through the quiet gate with a count-only body and directRequest false', async () => {
      const h = harness()
      const port = createRoutineResearchPort(h.newService())
      expect(await port(request, new AbortController().signal)).toEqual({ ok: true })
      expect(h.notifications).toEqual([{ title: 'Suggestions ready', body: '1 new suggestion', directRequest: false }])
      const text = JSON.stringify(h.notifications)
      expect(text).not.toContain('Budget')
    })

    it('does not nudge when a run finds nothing new', async () => {
      const h = harness()
      const service = h.newService()
      const port = createRoutineResearchPort(service)
      await port(request, new AbortController().signal)
      await port(request, new AbortController().signal)
      expect(h.notifications).toHaveLength(1)
    })

    it('three unopened nudges start a 1-day break, then 3, then 7 days; list and checkNow keep working', async () => {
      const h = harness()
      const service = h.newService()
      const port = createRoutineResearchPort(service)
      let topic = 0
      const freshCard = () => {
        topic += 1
        h.calendar.items = [
          {
            role: 'anchor',
            evidence: {
              ...h.calendar.items[0]!.evidence,
              ref: { accountRef: 'acct_1', eventKey: `a${topic}`.padEnd(8, '0') },
              label: `Topic ${topic}`,
              terms: [`alpha${topic}`, `beta${topic}`, `gamma${topic}`],
              eventAt: h.clock.now + HOUR
            } as never
          }
        ]
        h.memory.items = []
      }
      const nudges = () => h.notifications.length
      const run = async () => {
        freshCard()
        return port(request, new AbortController().signal)
      }
      for (let i = 0; i < 3; i += 1) await run()
      expect(nudges()).toBe(3)
      await run() // inside the 1-day break
      expect(nudges()).toBe(3)
      expect((await service.checkNow()).ok).toBe(true) // manual keeps working
      h.clock.now += DAY + 1
      await run()
      expect(nudges()).toBe(4)
      await run()
      await run()
      expect(nudges()).toBe(6)
      h.clock.now += 2 * DAY
      await run()
      expect(nudges()).toBe(6) // 3-day break still running
      h.clock.now += 2 * DAY
      await run()
      await run()
      await run()
      expect(nudges()).toBe(9)
      h.clock.now += 6 * DAY
      await run()
      expect(nudges()).toBe(9) // 7-day break still running
      h.clock.now += 2 * DAY
      await run()
      expect(nudges()).toBe(10)
    })

    it('opening the list resets the unopened streak', async () => {
      const h = harness()
      const service = h.newService()
      const port = createRoutineResearchPort(service)
      for (let i = 1; i <= 2; i += 1) {
        h.calendar.items = [
          {
            role: 'anchor',
            evidence: {
              ...h.calendar.items[0]!.evidence,
              ref: { accountRef: 'acct_1', eventKey: `a${i}`.padEnd(8, '0') },
              label: `Topic ${i}`,
              terms: [`alpha${i}`, `beta${i}`, `gamma${i}`],
              eventAt: h.clock.now + HOUR
            } as never
          }
        ]
        await port({ title: 't', tools: [] }, new AbortController().signal)
      }
      await service.list()
      for (let i = 3; i <= 5; i += 1) {
        h.calendar.items = [
          {
            role: 'anchor',
            evidence: {
              ...h.calendar.items[0]!.evidence,
              ref: { accountRef: 'acct_1', eventKey: `a${i}`.padEnd(8, '0') },
              label: `Topic ${i}`,
              terms: [`alpha${i}`, `beta${i}`, `gamma${i}`],
              eventAt: h.clock.now + HOUR
            } as never
          }
        ]
        await port({ title: 't', tools: [] }, new AbortController().signal)
      }
      expect(h.notifications).toHaveLength(5)
    })

    it('refuses web.search with an internal error and audits tool_unsupported', async () => {
      const h = harness()
      const port = createRoutineResearchPort(h.newService())
      expect(await port({ title: 't', tools: ['web.search'] }, new AbortController().signal)).toEqual({
        ok: false,
        errorClass: 'internal'
      })
      expect(h.audits).toContainEqual({ phase: 'refused', reason: 'tool_unsupported' })
      expect(h.calendar.calls).toBe(0)
    })

    it('honours an aborted signal: cancelled, nothing persisted, no nudge', async () => {
      const h = harness()
      const service = h.newService()
      const port = createRoutineResearchPort(service)
      const controller = new AbortController()
      const inner = h.calendar.gather.bind(h.calendar)
      h.calendar.gather = async (ctx) => {
        controller.abort()
        return inner(ctx)
      }
      expect(await port({ title: 't', tools: [] }, controller.signal)).toEqual({ ok: false, errorClass: 'cancelled' })
      expect(h.notifications).toEqual([])
      const list = await service.list()
      expect(list.ok && list.cards).toHaveLength(0)
    })
  })

  it('audit records carry no content', async () => {
    const h = harness()
    const service = h.newService()
    const { ref } = await oneCard(h, service)
    await service.shown(ref)
    await service.accept(ref)
    await createRoutineResearchPort(service)({ title: 'Morning prep', tools: [] }, new AbortController().signal)
    expect(h.audits.length).toBeGreaterThan(0)
    const text = JSON.stringify(h.audits)
    for (const secret of ['Budget', 'forecast', 'Morning prep', 'acct_', ref.id, ref.nonce]) {
      expect(text).not.toContain(secret)
    }
    for (const record of h.audits)
      expect(Object.keys(record).every((k) => ['phase', 'reason', 'count', 'ms'].includes(k))).toBe(true)
  })
})
