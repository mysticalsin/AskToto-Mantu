import { describe, expect, it, vi } from 'vitest'
import { BoundedRelayPcmQueue, RELAY_PCM_QUEUE_MAX_BYTES } from './relay-queue'

function frame(sequence: number, size = 3_200) {
  return { sequence, sampleOffset: (sequence - 1) * 1_600, pcm16le: new Uint8Array(size) }
}

describe('BoundedRelayPcmQueue', () => {
  it('bounds unsent continuous PCM to 64 KiB and fails closed on overflow', () => {
    const queue = new BoundedRelayPcmQueue()
    for (let sequence = 1; sequence <= 20; sequence++) {
      expect(queue.enqueue(frame(sequence), 1_000)).toEqual({ ok: true })
    }
    expect(queue.pendingBytes).toBe(64_000)
    expect(queue.pendingBytes).toBeLessThanOrEqual(RELAY_PCM_QUEUE_MAX_BYTES)
    expect(queue.enqueue(frame(21), 1_000)).toMatchObject({ ok: false, code: 'QUEUE_LIMIT' })
    expect(queue.enqueue(frame(21), 1_000)).toMatchObject({ ok: false, code: 'CLOSED' })
  })

  it('rejects gaps, duplicates, misaligned PCM, and non-contiguous sample offsets', () => {
    const queue = new BoundedRelayPcmQueue()
    expect(queue.enqueue(frame(2), 1_000)).toMatchObject({ ok: false, code: 'ORDER' })
    expect(queue.enqueue(frame(1, 3_201), 1_000)).toMatchObject({ ok: false, code: 'FRAME' })
    expect(queue.enqueue({ ...frame(1), sampleOffset: 1 }, 1_000)).toMatchObject({ ok: false, code: 'ORDER' })
    expect(queue.enqueue(frame(1), 1_000)).toEqual({ ok: true })
    expect(queue.enqueue(frame(1), 1_000)).toMatchObject({ ok: false, code: 'ORDER' })
  })

  it('sends each frame once in sequence and never retries an ambiguous send failure', async () => {
    const queue = new BoundedRelayPcmQueue()
    queue.enqueue(frame(1), 1_000)
    queue.enqueue(frame(2), 1_000)
    queue.enqueue(frame(3), 1_000)
    const send = vi.fn(async (_pcm: Uint8Array, sequence: number) => {
      if (sequence === 2) throw new Error('ambiguous transport failure')
    })

    expect(await queue.drain(send)).toEqual({ ok: false, code: 'SEND_FAILED' })
    expect(send.mock.calls.map(([, sequence]) => sequence)).toEqual([1, 2])
    expect(await queue.drain(send)).toMatchObject({ ok: false, code: 'CLOSED' })
    expect(send.mock.calls).toHaveLength(2)
  })

  it('fails when admitted audio exceeds the two-second age bound before send', async () => {
    const queue = new BoundedRelayPcmQueue()
    queue.enqueue(frame(1), 1_000)
    queue.enqueue(frame(2), 1_000)
    const send = vi.fn(async () => undefined)
    expect(await queue.drain(send, 3_001)).toEqual({ ok: false, code: 'QUEUE_STALE' })
    expect(send).not.toHaveBeenCalled()
  })

  it('does not strand frames admitted while an earlier drain is awaiting its send callback', async () => {
    const queue = new BoundedRelayPcmQueue()
    queue.enqueue(frame(1), 1_000)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const sent: number[] = []
    const send = async (_pcm: Uint8Array, sequence: number): Promise<void> => {
      sent.push(sequence)
      if (sequence === 1) await gate
    }

    const draining = queue.drain(send)
    queue.enqueue(frame(2), 1_000)
    expect(queue.drain(send)).toBe(draining)
    release()
    expect(await draining).toEqual({ ok: true })
    expect(sent).toEqual([1, 2])
  })
})
