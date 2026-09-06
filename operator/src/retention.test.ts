import { describe, expect, it } from 'vitest'
import { pruneRetention, RETENTION_MS } from './retention'
import { memoryStore } from './store'

const NOW = 1_725_000_000_000

describe('pruneRetention', () => {
  it('deletes events, audit, asks, and crm_sends older than their retention window, capped per call', async () => {
    const store = memoryStore()
    await store.insertEvent({ id: 'e-old', ts: NOW - RETENTION_MS.events - 1, kind: 'heartbeat', actor: null, device_id: 'd', country: null, detail: null })
    await store.insertEvent({ id: 'e-new', ts: NOW, kind: 'heartbeat', actor: null, device_id: 'd', country: null, detail: null })
    await store.audit('a-old', NOW - RETENTION_MS.audit - 1, 'tony', 'reveal', null, 'x')
    await store.audit('a-new', NOW, 'tony', 'reveal', null, 'x')
    await store.insertAsk(askRow({ id: 'ask-old', ts: NOW - RETENTION_MS.asks - 1 }))
    await store.insertAsk(askRow({ id: 'ask-new', ts: NOW }))

    const result = await pruneRetention(store, NOW)

    expect(result.events).toBe(1)
    expect(result.audit).toBe(1)
    expect(result.asks).toBe(1)
    expect((await store.listEvents(10)).map((e) => e.id)).toEqual(['e-new'])
    expect((await store.listAudit(10)).length).toBe(1)
    expect((await store.listAsks(10)).map((a) => a.id)).toEqual(['ask-new'])
  })

  it('caps deletions per call so one tick never runs away', async () => {
    const store = memoryStore()
    for (let i = 0; i < 10; i++) {
      await store.insertEvent({ id: `e-${i}`, ts: 0, kind: 'heartbeat', actor: null, device_id: 'd', country: null, detail: null })
    }
    const result = await pruneRetention(store, NOW, { events: 3 })
    expect(result.events).toBe(3)
  })

  it('closes stale sessions as part of the same pass', async () => {
    const store = memoryStore()
    await store.touchSession('dev-a', NOW - 10 * 60 * 1000, 'heartbeat', { country: 'CA', city: 'Longueuil' }, { os: 'darwin', app_version: '1.8.5' })
    const result = await pruneRetention(store, NOW)
    expect(result.staleSessionsClosed).toBe(1)
    const sessions = (await store.listSessions({ deviceId: 'dev-a', limit: 10 })).rows
    expect(sessions[0]?.ended_at).not.toBeNull()
  })

  it('does not touch rows inside the retention window', async () => {
    const store = memoryStore()
    await store.insertEvent({ id: 'e-recent', ts: NOW - 1000, kind: 'heartbeat', actor: null, device_id: 'd', country: null, detail: null })
    const result = await pruneRetention(store, NOW)
    expect(result.events).toBe(0)
    expect((await store.listEvents(10)).length).toBe(1)
  })
})

function askRow(partial: { id: string; ts: number }) {
  return {
    device_id: 'dev-a',
    mode: null,
    skill_id: null,
    skill_version: null,
    provider: null,
    model: null,
    ttft_ms: null,
    total_ms: null,
    input_tokens: null,
    output_tokens: null,
    cache_read: null,
    cache_write: null,
    cache_uncached: null,
    cache_status: null,
    cache_ttl: null,
    outcome: null,
    rating: null,
    prompt_cipher: null,
    prompt_iv: null,
    preview: null,
    question_type: null,
    ...partial
  }
}
