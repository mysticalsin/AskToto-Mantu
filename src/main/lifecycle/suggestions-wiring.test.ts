import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SUGGESTION_IPC } from '@shared/suggestions'
import { makeTempRoot } from '../features/dictation/__fixtures__/dictation-memory-fixtures'
import { anchor, fakeSource, open, seal, support } from '../features/suggestions/__fixtures__/suggestions-harness'
import type { AuthorizeSender } from '../ipc/sender-auth'
import { readModuleSource } from '../../test-helpers/module-source'
import { bootstrapSuggestions } from './suggestions-wiring'

const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)
const TENANT = '1'.repeat(64)
const PARTITION = 'a1'.repeat(12)
const roots: Array<{ remove(): void }> = []
afterEach(() => {
  while (roots.length) roots.pop()?.remove()
})

function wiring(state: { owner: string | null; tenant: string | null; partition: string | null; enabled?: boolean }) {
  const root = makeTempRoot('synthetic-suggestions-')
  roots.push(root)
  const handlers = new Map<string, (event: unknown, raw?: unknown) => Promise<unknown>>()
  let partitionListener: (() => void) | null = null
  let revoked: (() => void) | null = null
  const notify = vi.fn()
  const calendar = fakeSource('calendar', [
    anchor(1, 'Budget review', ['budget', 'review', 'forecast'], Date.now() + 3_600_000)
  ])
  const memory = fakeSource('memory', [support(2, 'Forecast numbers first', ['forecast', 'budget'])])
  const service = bootstrapSuggestions({
    ipcMain: { handle: (channel: string, fn: never) => void handlers.set(channel, fn) },
    authorizeSender: (() => null) as unknown as AuthorizeSender,
    requireAuth: () => true,
    ownerSession: {
      currentOwnerKey: () => state.owner,
      currentTenantKey: () => state.tenant,
      onRevoked: (cb) => {
        revoked = cb
        return () => undefined
      }
    },
    userDataPath: () => root.path,
    partition: () => state.partition,
    onPartitionChange: (cb) => {
      partitionListener = cb
      return () => undefined
    },
    sources: [calendar, memory],
    enabled: () => state.enabled ?? true,
    notify,
    seal,
    open,
    audit: () => undefined
  })
  return {
    root,
    handlers,
    service,
    notify,
    calendar,
    switched: () => partitionListener?.(),
    revoke: () => revoked?.(),
    call: (c: string, raw?: unknown) => handlers.get(c)!({}, raw)
  }
}

describe('suggestions wiring (G67)', () => {
  it('registers the channels and keeps the sealed file under userData/suggestions, named by partition', async () => {
    const w = wiring({ owner: KEY_A, tenant: TENANT, partition: PARTITION })
    expect([...w.handlers.keys()].sort()).toEqual(Object.values(SUGGESTION_IPC).sort())
    expect(await w.call(SUGGESTION_IPC.checkNow)).toMatchObject({ ok: true, created: 1 })
    const dir = join(w.root.path, 'suggestions')
    expect(readdirSync(dir)).toEqual([`${PARTITION}.bin`])
    const raw = readFileSync(join(dir, `${PARTITION}.bin`))
    expect(raw.toString('utf8')).not.toContain('Budget review')
    expect(open(raw)).toContain('Budget review')
  })

  it('has no scope without both keys and a partition in force', async () => {
    const state = {
      owner: KEY_A as string | null,
      tenant: TENANT as string | null,
      partition: PARTITION as string | null
    }
    const w = wiring(state)
    for (const missing of [{ owner: null }, { tenant: null }, { partition: null }]) {
      Object.assign(state, { owner: KEY_A, tenant: TENANT, partition: PARTITION }, missing)
      expect(await w.call(SUGGESTION_IPC.list)).toEqual({ ok: false, reason: 'signed-out' })
    }
    expect(existsSync(join(w.root.path, 'suggestions'))).toBe(false)
  })

  it('refuses a partition id that could escape the fixed directory', async () => {
    const w = wiring({ owner: KEY_A, tenant: TENANT, partition: '../other' })
    expect(await w.call(SUGGESTION_IPC.list)).toEqual({ ok: false, reason: 'unavailable' })
    expect(existsSync(join(w.root.path, 'suggestions'))).toBe(false)
  })

  it('is off until the setting is on', async () => {
    const w = wiring({ owner: KEY_A, tenant: TENANT, partition: PARTITION, enabled: false })
    expect(await w.call(SUGGESTION_IPC.checkNow)).toEqual({ ok: false, reason: 'disabled' })
    expect(w.calendar.calls).toBe(0)
  })

  it('onRevoked and a partition change both call onOwnerChange (abort the run in flight)', async () => {
    for (const trigger of ['revoke', 'switch'] as const) {
      const state = { owner: KEY_A as string | null, tenant: TENANT, partition: PARTITION as string | null }
      const w = wiring(state)
      const inner = w.calendar.gather.bind(w.calendar)
      w.calendar.gather = async (ctx) => {
        const out = await inner(ctx)
        state.owner = KEY_B
        if (trigger === 'revoke') w.revoke()
        else w.switched()
        return out
      }
      expect(await w.call(SUGGESTION_IPC.checkNow)).toMatchObject({ ok: true, run: { state: 'cancelled' } })
    }
  })

  it('is composed from the owner-session wiring, so index.ts gains no lines', () => {
    const source = readModuleSource(__dirname, './owner-session-wiring').text
    expect(source).toMatch(/bootstrapSuggestions\(\{/)
  })
})
