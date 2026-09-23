import { describe, expect, it } from 'vitest'
import { persistProxyAsk } from './ask-meter'
import { memoryStore } from './store'

const NOW = 1_725_000_000_000
const SHARED_ASK_ID = 'ask-shared-1234'

describe('persistProxyAsk ownership', () => {
  it('keeps a client ask id owned by its original device without letting a late failure downgrade its answer', async () => {
    const store = memoryStore()

    await persistProxyAsk(store, {
      deviceId: 'device-a',
      now: NOW,
      provider: 'cloudflare',
      model: 'first-model',
      outcome: 'answered',
      askId: SHARED_ASK_ID
    })
    await persistProxyAsk(store, {
      deviceId: 'device-b',
      now: NOW + 1,
      provider: 'anthropic',
      model: 'foreign-model',
      outcome: 'error',
      askId: SHARED_ASK_ID
    })

    expect(await store.getAsk(SHARED_ASK_ID)).toMatchObject({
      device_id: 'device-a',
      provider: 'cloudflare',
      model: 'first-model',
      outcome: 'answered'
    })

    await persistProxyAsk(store, {
      deviceId: 'device-a',
      now: NOW + 2,
      provider: 'cloudflare',
      model: 'retry-model',
      outcome: 'error',
      askId: SHARED_ASK_ID
    })

    expect(await store.getAsk(SHARED_ASK_ID)).toMatchObject({
      device_id: 'device-a',
      model: 'first-model',
      outcome: 'answered'
    })
    expect(await store.listAsks(10)).toHaveLength(1)
  })
})
