import { describe, expect, it, vi } from 'vitest'
import { PRE_MS, WIN_MS, POST_MS } from './gates'
import { TAP_WORKLET_SRC } from './tap-worklet-src'

/**
 * Transplant guard (same idea as the whisper worklet's): the worklet source is a string, so nothing
 * type-checks it — this test actually EXECUTES it with the worklet globals stubbed and drives the
 * processor with synthetic quanta, proving the embedded makeTapOnset + ring-buffer capture work as a
 * unit before any real AudioContext is involved.
 */
function instantiate(sampleRate: number): {
  proc: {
    process: (inputs: Float32Array[][]) => boolean
    port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: ReturnType<typeof vi.fn> }
  }
} {
  let ctor: (new () => unknown) | null = null
  class FakeAudioWorkletProcessor {
    port = { onmessage: null as ((e: { data: unknown }) => void) | null, postMessage: vi.fn() }
  }
  const register = (_name: string, klass: new () => unknown): void => {
    ctor = klass
  }
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', TAP_WORKLET_SRC)(
    FakeAudioWorkletProcessor,
    register,
    sampleRate
  )
  if (!ctor) throw new Error('worklet source did not register a processor')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { proc: new ctor() as any }
}

const SR = 48000
const QUANTUM = 128

function feed(proc: { process: (i: Float32Array[][]) => boolean }, quanta: Float32Array[]): void {
  for (const q of quanta) proc.process([[q]])
}

const quiet = (): Float32Array => {
  const q = new Float32Array(QUANTUM)
  for (let i = 0; i < QUANTUM; i++) q[i] = (Math.sin(i * 0.7) + Math.cos(i * 1.3)) * 0.0005
  return q
}
const loud = (amp = 0.4): Float32Array => {
  const q = new Float32Array(QUANTUM)
  for (let i = 0; i < QUANTUM; i++) q[i] = Math.sin((2 * Math.PI * 300 * i) / SR) * amp
  return q
}

describe('tap worklet source', () => {
  it('embeds the tested onset factory', () => {
    expect(TAP_WORKLET_SRC).toContain('makeTapOnset')
    expect(TAP_WORKLET_SRC).toContain("registerProcessor('tap-worklet'")
  })

  it('captures PRE+WIN+POST around a trigger and posts one transferable buffer', () => {
    const { proc } = instantiate(SR)
    const total = Math.round(((PRE_MS + WIN_MS + POST_MS) / 1000) * SR)
    // Fill the ring with quiet (past the validity guard), then hit it.
    const quietCount = Math.ceil(total / QUANTUM) + 50
    feed(proc, Array.from({ length: quietCount }, quiet))
    feed(proc, [loud()])
    // Post-roll: WIN+POST worth of quanta.
    const postCount = Math.ceil((((WIN_MS + POST_MS) / 1000) * SR) / QUANTUM) + 2
    feed(proc, Array.from({ length: postCount }, quiet))

    expect(proc.port.postMessage).toHaveBeenCalledTimes(1)
    const msg = proc.port.postMessage.mock.calls[0][0] as {
      pcm: Float32Array
      floorRms: number
      sampleRate: number
    }
    expect(msg.sampleRate).toBe(SR)
    expect(msg.pcm.length).toBe(total)
    expect(msg.floorRms).toBeGreaterThan(0)
    // The strike must sit at the PRE boundary of the linearized capture: PRE segment quiet, then loud.
    const pre = Math.round((PRE_MS / 1000) * SR)
    const preRms = Math.sqrt(msg.pcm.subarray(0, pre).reduce((s, v) => s + v * v, 0) / pre)
    const strike = msg.pcm.subarray(pre, pre + QUANTUM)
    const strikeRms = Math.sqrt(strike.reduce((s, v) => s + v * v, 0) / strike.length)
    expect(strikeRms).toBeGreaterThan(preRms * 20)
  })

  it('does not trigger before the ring has filled once', () => {
    const { proc } = instantiate(SR)
    feed(proc, [loud()]) // instant loud input on a cold ring
    const postCount = Math.ceil((((WIN_MS + POST_MS) / 1000) * SR) / QUANTUM) + 2
    feed(proc, Array.from({ length: postCount }, quiet))
    expect(proc.port.postMessage).not.toHaveBeenCalled()
  })

  it('sensitivity message reaches the embedded onset detector', () => {
    const { proc } = instantiate(SR)
    expect(proc.port.onmessage).toBeTypeOf('function')
    // Sanity: a malformed message must not throw.
    proc.port.onmessage!({ data: 'flush' })
    proc.port.onmessage!({ data: { sensitivity: 0.9 } })
  })

  it('works at 44.1k too (ring sized from the real sampleRate)', () => {
    const { proc } = instantiate(44100)
    const total = Math.round(((PRE_MS + WIN_MS + POST_MS) / 1000) * 44100)
    feed(proc, Array.from({ length: Math.ceil(total / QUANTUM) + 50 }, quiet))
    feed(proc, [loud()])
    feed(proc, Array.from({ length: Math.ceil((((WIN_MS + POST_MS) / 1000) * 44100) / QUANTUM) + 2 }, quiet))
    expect(proc.port.postMessage).toHaveBeenCalledTimes(1)
    const msg = proc.port.postMessage.mock.calls[0][0] as { pcm: Float32Array }
    expect(msg.pcm.length).toBe(total)
  })
})
