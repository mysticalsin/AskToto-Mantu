import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ingestCanonical, OPERATOR_HMAC_HEADERS } from '../../src/shared/operator-hmac'
import { sha256Hex } from './crypto'
import { hmacHex } from './hmac'
import { handleRequest, type Env } from './index'
import { memoryStore, type OperatorStore } from './store'
import { TEST_ADMIN_EMAILS, TEST_INGEST_SECRET, TEST_PROMPT_KEY } from './test-fixtures'

// V08: a desktop `voice_action` event is metadata only and lands as one activity event, never as an Ask.

const NOW = 1_725_000_000_000
const DEVICE = 'device-voice-a'
const ENV: Env = {
  OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
  OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
  ADMIN_EMAILS: TEST_ADMIN_EMAILS
}

async function signedIngest(
  store: OperatorStore,
  payload: Record<string, unknown>,
  deviceId = DEVICE
): Promise<Response> {
  const body = JSON.stringify(payload)
  const ts = String(NOW)
  const nonce = randomUUID()
  const digest = await sha256Hex(body)
  const signature = await hmacHex(TEST_INGEST_SECRET, ingestCanonical(ts, nonce, deviceId, digest))
  const request = new Request('https://operator.test/v1/ingest', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [OPERATOR_HMAC_HEADERS.ts]: ts,
      [OPERATOR_HMAC_HEADERS.nonce]: nonce,
      [OPERATOR_HMAC_HEADERS.device]: deviceId,
      [OPERATOR_HMAC_HEADERS.sig]: signature
    },
    body
  })
  return handleRequest(request, ENV, {}, { store, now: NOW })
}

const voiceAction = {
  event: 'voice_action',
  id: 'va-1',
  ts: NOW,
  source: 'hold',
  actionId: 'desktop.create_note',
  class: 'create',
  outcome: 'done',
  latencyBucket: 'under_1s'
}

describe('voice_action ingest', () => {
  it('stores one metadata-only activity event, never an Ask, and dedupes a replay', async () => {
    const store = memoryStore()
    const payload = { ...voiceAction, transcript: 'create a note called synthetic-words', title: 'Synthetic title' }
    expect((await signedIngest(store, payload)).status).toBe(200)
    expect((await signedIngest(store, payload)).status).toBe(200)
    const events = await store.listEvents(10)
    expect(events.map((event) => event.kind)).toEqual(['voice_action'])
    expect(events[0]).toMatchObject({ device_id: DEVICE, detail: 'desktop.create_note:done' })
    expect(JSON.stringify(events)).not.toMatch(/synthetic/i)
    expect(await store.getAsk('va-1')).toBeNull()
  })

  it('keeps the same client id from two signed devices separate', async () => {
    const store = memoryStore()
    expect((await signedIngest(store, voiceAction, DEVICE)).status).toBe(200)
    expect((await signedIngest(store, voiceAction, 'device-voice-b')).status).toBe(200)
    const events = (await store.listEvents(10)).filter((event) => event.kind === 'voice_action')
    expect(events.map((event) => event.device_id).sort()).toEqual([DEVICE, 'device-voice-b'])
  })

  it('does not let a voice action collide with an Ask that owns the same id', async () => {
    const store = memoryStore()
    expect(
      (await signedIngest(store, { id: 'va-1', ts: NOW, mode: 'answer', outcome: 'answered', questionType: 'factual' }))
        .status
    ).toBe(200)
    expect((await signedIngest(store, voiceAction, 'device-voice-b')).status).toBe(200)
    expect((await store.getAsk('va-1'))?.device_id).toBe(DEVICE)
  })
})
