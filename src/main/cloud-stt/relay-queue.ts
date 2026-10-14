export const RELAY_PCM_QUEUE_MAX_BYTES = 64 * 1024
export const RELAY_PCM_QUEUE_MAX_AGE_MS = 2_000
export const RELAY_PCM_QUEUE_MAX_FRAMES = 20
export const RELAY_PCM_MAX_FRAME_BYTES = 64 * 1024

export type RelayPcmFrame = {
  sequence: number
  sampleOffset: number
  pcm16le: Uint8Array
}

export type RelayQueueFailureCode = 'CLOSED' | 'FRAME' | 'ORDER' | 'QUEUE_LIMIT' | 'QUEUE_STALE' | 'SEND_FAILED'
export type RelayQueueResult = { ok: true } | { ok: false; code: RelayQueueFailureCode }

type QueuedFrame = RelayPcmFrame & { admittedAt: number }
type QueueClock = number | (() => number)

/** One-way, bounded queue for PCM frames that have not yet been handed to the relay WebSocket. */
export class BoundedRelayPcmQueue {
  private queue: QueuedFrame[] = []
  private bytes = 0
  private nextSequence = 1
  private nextSampleOffset = 0
  private sealed = false
  private failed = false
  private draining: Promise<RelayQueueResult> | null = null
  private drainAgain = false

  get pendingBytes(): number {
    return this.bytes
  }

  get pendingFrames(): number {
    return this.queue.length
  }

  get isDrained(): boolean {
    return this.queue.length === 0 && this.draining === null
  }

  enqueue(frame: RelayPcmFrame, now = Date.now()): RelayQueueResult {
    if (this.sealed || this.failed) return { ok: false, code: 'CLOSED' }
    if (
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(frame.sequence) ||
      frame.sequence < 1 ||
      !Number.isSafeInteger(frame.sampleOffset) ||
      frame.sampleOffset < 0 ||
      !(frame.pcm16le instanceof Uint8Array) ||
      frame.pcm16le.byteLength < 2 ||
      frame.pcm16le.byteLength > RELAY_PCM_MAX_FRAME_BYTES ||
      frame.pcm16le.byteLength % 2 !== 0
    )
      return { ok: false, code: 'FRAME' }
    if (frame.sequence !== this.nextSequence || frame.sampleOffset !== this.nextSampleOffset)
      return { ok: false, code: 'ORDER' }

    const oldest = this.queue[0]
    if (oldest && now - oldest.admittedAt > RELAY_PCM_QUEUE_MAX_AGE_MS) {
      this.fail()
      return { ok: false, code: 'QUEUE_STALE' }
    }
    if (
      this.queue.length >= RELAY_PCM_QUEUE_MAX_FRAMES ||
      this.bytes + frame.pcm16le.byteLength > RELAY_PCM_QUEUE_MAX_BYTES
    ) {
      this.fail()
      return { ok: false, code: 'QUEUE_LIMIT' }
    }

    this.queue.push({
      sequence: frame.sequence,
      sampleOffset: frame.sampleOffset,
      pcm16le: frame.pcm16le.slice(),
      admittedAt: now
    })
    this.bytes += frame.pcm16le.byteLength
    this.nextSequence += 1
    this.nextSampleOffset += frame.pcm16le.byteLength / 2
    return { ok: true }
  }

  /** Stops admission while allowing the accepted FIFO to drain before the ordered finish marker. */
  seal(): void {
    this.sealed = true
  }

  /**
   * Calls `send` exactly once per dequeued frame. If it throws, delivery is ambiguous: the queue is
   * destroyed and the attempted frame is never replayed by a later drain call.
   */
  drain(
    send: (pcm16le: Uint8Array, sequence: number, sampleOffset: number) => Promise<void> | void,
    now: QueueClock = Date.now
  ): Promise<RelayQueueResult> {
    if (this.draining) {
      this.drainAgain = true
      return this.draining
    }
    if (this.failed) return Promise.resolve({ ok: false, code: 'CLOSED' })
    this.draining = this.drainUntilStable(send, now).finally(() => {
      this.draining = null
    })
    return this.draining
  }

  close(): void {
    this.fail()
  }

  private async drainQueue(
    send: (pcm16le: Uint8Array, sequence: number, sampleOffset: number) => Promise<void> | void,
    now: QueueClock
  ): Promise<RelayQueueResult> {
    while (this.queue.length > 0) {
      if (this.failed) return { ok: false, code: 'CLOSED' }
      const frame = this.queue.shift()!
      this.bytes -= frame.pcm16le.byteLength
      const dequeuedAt = typeof now === 'function' ? now() : now
      if (dequeuedAt - frame.admittedAt > RELAY_PCM_QUEUE_MAX_AGE_MS) {
        this.fail()
        return { ok: false, code: 'QUEUE_STALE' }
      }
      try {
        await send(frame.pcm16le, frame.sequence, frame.sampleOffset)
      } catch {
        this.fail()
        return { ok: false, code: 'SEND_FAILED' }
      }
    }
    return this.failed ? { ok: false, code: 'CLOSED' } : { ok: true }
  }

  private async drainUntilStable(
    send: (pcm16le: Uint8Array, sequence: number, sampleOffset: number) => Promise<void> | void,
    now: QueueClock
  ): Promise<RelayQueueResult> {
    for (;;) {
      this.drainAgain = false
      const result = await this.drainQueue(send, now)
      if (!result.ok || (this.queue.length === 0 && !this.drainAgain)) return result
    }
  }

  private fail(): void {
    this.failed = true
    this.sealed = true
    this.queue = []
    this.bytes = 0
  }
}
