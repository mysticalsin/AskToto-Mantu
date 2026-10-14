import { describe, expect, it } from 'vitest'
import { createCloudSpeechRequestFence } from './cloud-speech-request-fence'

describe('cloud speech capability request fence', () => {
  it('keeps a newer refusal when an older ready response resolves afterward', async () => {
    const fence = createCloudSpeechRequestFence()
    let resolveFirst!: (value: 'ready' | 'denied') => void
    let resolveSecond!: (value: 'ready' | 'denied') => void
    const firstResponse = new Promise<'ready' | 'denied'>((resolve) => {
      resolveFirst = resolve
    })
    const secondResponse = new Promise<'ready' | 'denied'>((resolve) => {
      resolveSecond = resolve
    })
    let displayed: 'ready' | 'denied' | null = null
    const apply = async (response: Promise<'ready' | 'denied'>): Promise<void> => {
      const requestId = fence.begin()
      const result = await response
      if (fence.isCurrent(requestId)) displayed = result
    }
    const first = apply(firstResponse)
    const second = apply(secondResponse)

    resolveSecond('denied')
    await second
    resolveFirst('ready')
    await first

    expect(displayed).toBe('denied')
  })

  it('invalidates pending requests when their owning effect is replaced', () => {
    const fence = createCloudSpeechRequestFence()
    const requestId = fence.begin()
    fence.invalidate()
    expect(fence.isCurrent(requestId)).toBe(false)
  })
})
