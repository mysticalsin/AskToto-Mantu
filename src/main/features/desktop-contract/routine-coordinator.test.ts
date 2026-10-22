import { describe, expect, it } from 'vitest'
import { FixtureSessionContext } from '../../../test-helpers/desktop-contract-context'
import {
  type ReserveInput,
  RoutineCoordinator,
  type RoutineConfiguration,
  type RoutineTicket
} from './routine-coordinator'

const scope = { tenantId: 'mantu', userId: 'tony-fixture', sessionId: 'desktop-fixture' }
const connection = { connectionId: 'drive', accountId: 'work', resourceId: 'approved-folder' }
const config: RoutineConfiguration = {
  id: 'morning',
  assistantId: 'meeting-prep',
  revision: 1,
  timeZone: 'America/Sao_Paulo',
  purpose: 'read_only_suggestion',
  enabled: true,
  tools: ['connector.read', 'web.search'],
  connections: [connection]
}

function expectCode(fn: () => unknown, expected: string | string[]): void {
  let caught: unknown
  try {
    fn()
  } catch (error) {
    caught = error
  }
  expect(caught, `expected ${String(expected)}`).toBeDefined()
  const code = (caught as { code?: string }).code ?? ''
  expect(Array.isArray(expected) ? expected : [expected]).toContain(code)
}

function ticketOf(result: ReturnType<RoutineCoordinator['reserve']>): RoutineTicket {
  if (result.status !== 'reserved') throw new Error(`not reserved: ${result.status}`)
  return result.ticket
}

function fixture(
  options: { context?: FixtureSessionContext; checkpoint?: unknown; maxRecords?: number; now?: number } = {}
) {
  let now = options.now ?? 1000
  const context = options.context ?? new FixtureSessionContext({ scope, permissions: ['connector.read', 'web.search'] })
  const coordinator = new RoutineCoordinator({
    context,
    clock: () => now,
    ...(options.maxRecords !== undefined ? { maxRecords: options.maxRecords } : {}),
    ...(options.checkpoint !== undefined ? { checkpoint: options.checkpoint } : {})
  })
  if (options.checkpoint === undefined) coordinator.register(config)
  const due = (occurrenceKey = '2026-10-17-morning', overrides: Partial<ReserveInput> = {}) =>
    coordinator.reserve({
      routineId: 'morning',
      occurrenceKey,
      dueAtMs: 900,
      expiresAtMs: 5000,
      appOpen: true,
      policyAllowed: true,
      quotaAvailable: true,
      ...overrides
    })
  return {
    coordinator,
    context,
    due,
    setTime: (value: number) => {
      now = value
    }
  }
}

describe('RoutineCoordinator (ported reference contract)', () => {
  it('reserves an occurrence once and does not grant external effect authority', () => {
    const f = fixture()
    const result = f.due()
    expect(result.status).toBe('reserved')
    expect(ticketOf(result).authorizesExternalEffects).toBe(false)
    expect(f.due().status).toBe('already_recorded')
  })

  it('two due occurrences cannot overlap for the same routine', () => {
    const f = fixture()
    f.due('one')
    expect(f.due('two').status).toBe('overlap_blocked')
  })

  it('a later occurrence can start after a settled result', () => {
    const f = fixture()
    f.coordinator.settle(ticketOf(f.due('one')), 'succeeded')
    expect(f.due('two').status).toBe('reserved')
  })

  it('quota, policy and app closure block admission without consuming an occurrence', () => {
    const f = fixture()
    for (const [flag, status] of [
      ['quotaAvailable', 'quota_blocked'],
      ['policyAllowed', 'policy_blocked'],
      ['appOpen', 'app_closed']
    ] as const) {
      expect(f.due('one', { [flag]: false }).status).toBe(status)
    }
    expect(f.due('one').status).toBe('reserved')
  })

  it('missed and future schedules do not produce a catch-up flood', () => {
    const f = fixture()
    expect(f.due('old', { dueAtMs: 100, expiresAtMs: 900 }).status).toBe('expired')
    expect(f.due('future', { dueAtMs: 1200 }).status).toBe('not_due')
  })

  it('DST duplicate civil occurrence keys remain a single recorded occurrence', () => {
    const f = fixture()
    f.coordinator.settle(ticketOf(f.due('civil-slot')), 'succeeded')
    expect(f.due('civil-slot', { dueAtMs: 950 }).status).toBe('already_recorded')
  })

  it('read-only suggestions reject a declared write capability at registration', () => {
    const f = fixture()
    expectCode(() => f.coordinator.register({ ...config, id: 'bad', tools: ['email.send'] }), 'SUGGESTION_WRITE_TOOL')
  })

  it('a permitted read remains tied to the exact account and resource', () => {
    const f = fixture()
    const ticket = ticketOf(f.due())
    expect(f.coordinator.assertReadCall(ticket, { tool: 'connector.read', connection })).toBe(true)
    expectCode(
      () =>
        f.coordinator.assertReadCall(ticket, {
          tool: 'connector.read',
          connection: { ...connection, accountId: 'personal' }
        }),
      'ROUTINE_RESOURCE_DENIED'
    )
    expectCode(
      () =>
        f.coordinator.assertReadCall(ticket, {
          tool: 'connector.read',
          connection: { ...connection, resourceId: 'other' }
        }),
      'ROUTINE_RESOURCE_DENIED'
    )
  })

  it('write attempts cannot reuse a read-only research ticket', () => {
    const f = fixture()
    expectCode(
      () => f.coordinator.assertReadCall(ticketOf(f.due()), { tool: 'email.send', connection }),
      'ROUTINE_READ_TOOL_DENIED'
    )
  })

  it('forged ticket objects fail even when all visible fields match', () => {
    const f = fixture()
    const ticket = ticketOf(f.due())
    expectCode(() => f.coordinator.assertReadCall({ ...ticket }, { tool: 'web.search' }), 'ROUTINE_TICKET_NOT_ISSUED')
  })

  it('three consecutive failures pause future runs and resume is explicit', () => {
    const f = fixture()
    for (const key of ['one', 'two', 'three']) f.coordinator.settle(ticketOf(f.due(key)), 'failed')
    expect(f.due('four').status).toBe('paused_failure')
    f.coordinator.resume('morning')
    expect(f.due('four').status).toBe('reserved')
  })

  it('success resets the consecutive failure counter', () => {
    const f = fixture()
    for (const [key, result] of [
      ['one', 'failed'],
      ['two', 'failed'],
      ['three', 'succeeded'],
      ['four', 'failed']
    ] as const) {
      f.coordinator.settle(ticketOf(f.due(key)), result)
    }
    expect(f.coordinator.rule('morning').failures).toBe(1)
    expect(f.coordinator.rule('morning').state).toBe('enabled')
  })

  it('an uncertain result pauses future work until independent reconciliation', () => {
    const f = fixture()
    const ticket = ticketOf(f.due())
    expect(f.coordinator.settle(ticket, 'uncertain').publishable).toBe(false)
    expectCode(() => f.coordinator.resume('morning'), 'ROUTINE_RECONCILIATION_REQUIRED')
    f.coordinator.reconcile(ticket.key, 'succeeded')
    f.coordinator.resume('morning')
    expect(f.due().status).toBe('already_recorded')
  })

  it('only a successful current outcome is eligible for result publication', () => {
    for (const outcome of ['succeeded', 'failed', 'cancelled', 'uncertain']) {
      const f = fixture()
      expect(f.coordinator.settle(ticketOf(f.due()), outcome).publishable).toBe(outcome === 'succeeded')
    }
  })

  it('user pause immediately stops reads in an existing run', () => {
    const f = fixture()
    const ticket = ticketOf(f.due())
    f.coordinator.pause('morning')
    expectCode(() => f.coordinator.assertReadCall(ticket, { tool: 'web.search' }), 'ROUTINE_PAUSED')
    expect(f.coordinator.settle(ticket, 'succeeded').publishable).toBe(false)
  })

  it('a registered read tool still needs the current host permission', () => {
    const context = new FixtureSessionContext({ scope, permissions: [] })
    const f = fixture({ context })
    expectCode(
      () => f.coordinator.assertReadCall(ticketOf(f.due()), { tool: 'web.search' }),
      'ROUTINE_READ_PERMISSION_DENIED'
    )
  })

  it('colon-containing routine and occurrence identifiers cannot collide', () => {
    const f = fixture()
    f.coordinator.register({ ...config, id: 'morning:1', revision: 2 })
    const first = ticketOf(f.due('2:slot'))
    const second = f.coordinator.reserve({
      routineId: 'morning:1',
      occurrenceKey: 'slot',
      dueAtMs: 900,
      expiresAtMs: 5000,
      appOpen: true,
      policyAllowed: true,
      quotaAvailable: true
    })
    expect(second.status).toBe('reserved')
    expect(first.key).not.toBe(ticketOf(second).key)
  })

  it('context or permission changes invalidate pending read work', () => {
    const f = fixture()
    const ticket = ticketOf(f.due())
    f.context.setPermissions([])
    expectCode(
      () => f.coordinator.assertReadCall(ticket, { tool: 'web.search' }),
      ['STALE_GENERATION', 'STALE_CONTEXT', 'STALE_PERMISSIONS']
    )
    expect(f.coordinator.settle(ticket, 'succeeded').publishable).toBe(false)
  })

  it('closure blocks work while preserving the ability to record a late outcome', () => {
    const f = fixture()
    const ticket = ticketOf(f.due())
    f.coordinator.close()
    expectCode(() => f.coordinator.assertReadCall(ticket, { tool: 'web.search' }), 'ROUTINE_STOPPED')
    expect(f.coordinator.settle(ticket, 'succeeded').publishable).toBe(false)
  })

  it('an expired ticket cannot continue research', () => {
    const f = fixture()
    const ticket = ticketOf(f.due())
    f.setTime(5000)
    expectCode(() => f.coordinator.assertReadCall(ticket, { tool: 'web.search' }), 'ROUTINE_TICKET_EXPIRED')
  })

  it('outcomes cannot settle twice', () => {
    const f = fixture()
    const ticket = ticketOf(f.due())
    f.coordinator.settle(ticket, 'succeeded')
    expectCode(() => f.coordinator.settle(ticket, 'failed'), 'ROUTINE_ALREADY_SETTLED')
  })

  it('completed occurrences stay deduplicated after an owner-scoped checkpoint restore', () => {
    const f = fixture()
    f.coordinator.settle(ticketOf(f.due()), 'succeeded')
    const next = fixture({ checkpoint: JSON.parse(JSON.stringify(f.coordinator.checkpoint())) })
    expect(next.due().status).toBe('already_recorded')
  })

  it('a running occurrence becomes uncertain after restart and is never silently replayed', () => {
    const f = fixture()
    const ticket = ticketOf(f.due())
    const next = fixture({ checkpoint: f.coordinator.checkpoint() })
    expect(next.due().status).toBe('already_recorded')
    expect(next.due('new').status).toBe('paused_review')
    expectCode(() => next.coordinator.resume('morning'), 'ROUTINE_RECONCILIATION_REQUIRED')
    expectCode(() => next.coordinator.settle(ticket, 'succeeded'), 'ROUTINE_TICKET_NOT_ISSUED')
  })

  it('a checkpoint cannot be imported into a different user identity', () => {
    const f = fixture()
    const other = new FixtureSessionContext({ scope: { ...scope, userId: 'another-user' } })
    expectCode(
      () => new RoutineCoordinator({ context: other, checkpoint: f.coordinator.checkpoint() }),
      'ROUTINE_CHECKPOINT_OWNER'
    )
  })

  it('bounded journal refuses overflow instead of forgetting duplicate protection', () => {
    const f = fixture({ maxRecords: 1 })
    f.coordinator.settle(ticketOf(f.due('one')), 'succeeded')
    expectCode(() => f.due('two'), 'ROUTINE_JOURNAL_FULL')
  })

  it('malformed clocks, time zones and temporal bounds are rejected', () => {
    const f = fixture()
    expectCode(() => f.coordinator.register({ ...config, id: 'badzone', timeZone: 'Wrong/Zone' }), 'ROUTINE_TIMEZONE')
    expectCode(() => f.due('badtime', { expiresAtMs: 900 }), 'OCCURRENCE_TIME')
    f.setTime(Number.NaN)
    expectCode(() => f.due(), 'ROUTINE_CLOCK_VALUE')
  })
})

describe('RoutineCoordinator restore recomputes publishable (G07 fix)', () => {
  /** A succeeded, publishable run, checkpointed, then edited the way a stale or forged file could be. */
  function succeededCheckpoint() {
    const f = fixture()
    const settled = f.coordinator.settle(ticketOf(f.due()), 'succeeded')
    expect(settled.publishable).toBe(true)
    const saved = JSON.parse(JSON.stringify(f.coordinator.checkpoint()))
    return { f, saved, key: settled.key }
  }
  const publishableOf = (next: ReturnType<typeof fixture>, key: string) =>
    next.coordinator.checkpoint().runs.find((run) => run.key === key)?.publishable

  it('a still-valid succeeded run stays publishable after restore', () => {
    const { saved, key } = succeededCheckpoint()
    expect(publishableOf(fixture({ checkpoint: saved }), key)).toBe(true)
  })

  it('a saved publishable flag cannot outlive the run expiry', () => {
    const { saved, key } = succeededCheckpoint()
    expect(saved.runs[0].publishable).toBe(true)
    expect(publishableOf(fixture({ checkpoint: saved, now: 5000 }), key)).toBe(false)
  })

  it('a saved publishable flag cannot outlive a paused routine', () => {
    const { saved, key } = succeededCheckpoint()
    saved.rules[0].state = 'paused_user'
    expect(publishableOf(fixture({ checkpoint: saved }), key)).toBe(false)
  })

  it('a forged publishable flag on a failed, cancelled or uncertain run is ignored', () => {
    for (const status of ['failed', 'cancelled', 'uncertain']) {
      const { saved, key } = succeededCheckpoint()
      saved.runs[0].status = status
      saved.runs[0].publishable = true
      expect(publishableOf(fixture({ checkpoint: saved }), key)).toBe(false)
    }
  })

  it('a running run restored as uncertain is never publishable even if the file says so', () => {
    const f = fixture()
    const ticket = ticketOf(f.due())
    const saved = JSON.parse(JSON.stringify(f.coordinator.checkpoint()))
    saved.runs[0].publishable = true
    const next = fixture({ checkpoint: saved })
    const run = next.coordinator.checkpoint().runs.find((entry) => entry.key === ticket.key)
    expect(run?.status).toBe('uncertain')
    expect(run?.publishable).toBe(false)
  })

  it('a reconciled run is not publishable after restore even if the file says it is', () => {
    const f = fixture()
    const ticket = ticketOf(f.due())
    f.coordinator.settle(ticket, 'uncertain')
    f.coordinator.reconcile(ticket.key, 'succeeded')
    const saved = JSON.parse(JSON.stringify(f.coordinator.checkpoint()))
    saved.runs[0].publishable = true
    expect(publishableOf(fixture({ checkpoint: saved }), ticket.key)).toBe(false)
  })

  it('a stored false is never upgraded to true by restore', () => {
    const { saved, key } = succeededCheckpoint()
    saved.runs[0].publishable = false
    expect(publishableOf(fixture({ checkpoint: saved }), key)).toBe(false)
  })

  it('restore drops unknown run fields and rejects malformed times', () => {
    const { saved, key } = succeededCheckpoint()
    saved.runs[0].extra = 'ignored'
    const next = fixture({ checkpoint: saved })
    expect(next.coordinator.checkpoint().runs.find((run) => run.key === key)).not.toHaveProperty('extra')
    const bad = JSON.parse(JSON.stringify(saved))
    bad.runs[0].finishedAtMs = -1
    expectCode(() => fixture({ checkpoint: bad }), 'ROUTINE_CHECKPOINT_TIME')
  })
})
