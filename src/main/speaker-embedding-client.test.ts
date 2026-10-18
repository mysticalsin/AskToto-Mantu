import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PackageRuntimeContract } from './features/components/speech-pack/package-contract'

class FakeChild extends EventEmitter {
  readonly postMessage = vi.fn()
  readonly kill = vi.fn(() => true)
  readonly stderr = new EventEmitter()
  readonly stdout = new EventEmitter()
}

// These utility-host tests exercise the unconfigured development runtime boundary.
const electron = vi.hoisted(() => ({ app: { isPackaged: false }, utilityProcess: { fork: vi.fn() } }))
vi.mock('electron', () => electron)
vi.mock('./logger', () => ({ mainLog: { warn: vi.fn(), error: vi.fn() } }))

let child: FakeChild
let api: typeof import('./speaker-embedding-client')
type ResizableArrayBuffer = ArrayBuffer & { resize(byteLength: number): void }
const ResizableBuffer = ArrayBuffer as unknown as {
  new (byteLength: number, options: { maxByteLength: number }): ResizableArrayBuffer
}

const fullRuntime: PackageRuntimeContract = { status: 'legacy-full', profile: 'full', inventory: null }
const invalidRuntime: PackageRuntimeContract = {
  status: 'invalid', reason: 'inventory-invalid', profile: null, inventory: null
}

async function heldRuntimeAuthority() {
  const { configurePackageRuntimeContractProvider } = await import('./features/components/speech-pack/package-runtime-state')
  let resolve!: (contract: PackageRuntimeContract) => void
  let next: Promise<PackageRuntimeContract>
  const hold = () => { next = new Promise((done) => { resolve = done }) }
  hold()
  const provider = vi.fn(() => next)
  configurePackageRuntimeContractProvider(provider)
  electron.app.isPackaged = true
  return {
    provider,
    hold,
    settle(contract: PackageRuntimeContract) {
      next = Promise.resolve(contract)
      resolve(contract)
    }
  }
}

async function settleHeldWork(authority: Awaited<ReturnType<typeof heldRuntimeAuthority>>, work: Promise<unknown>[]) {
  authority.settle(invalidRuntime)
  const settled = Promise.allSettled([
    ...work, api.releaseSpeakerEmbedding('live'), api.releaseSpeakerEmbedding('import')
  ])
  for (const result of electron.utilityProcess.fork.mock.results) {
    if (result.type === 'return') (result.value as FakeChild).emit('exit', 0)
  }
  await settled
}

async function request(type = 'embed', target = child, occurrence = 1): Promise<Record<string, unknown>> {
  return vi.waitFor(() => {
    const found = target.postMessage.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((m) => m.type === type)[occurrence - 1]
    expect(found, `speaker child must receive ${type} #${occurrence}`).toBeDefined()
    return found!
  })
}

beforeEach(async () => {
  vi.resetModules()
  electron.app.isPackaged = false
  child = new FakeChild()
  electron.utilityProcess.fork.mockReset().mockReturnValue(child)
  api = await import('./speaker-embedding-client')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('speaker embedding utility client', () => {
  it.each(['mutate', 'detach', 'resize'] as const)(
    'snapshots PCM before held runtime authority when the caller immediately %ss its buffer',
    async (change) => {
      const authority = await heldRuntimeAuthority()
      const buffer = new ResizableBuffer(8, { maxByteLength: 8 })
      const samples = new Float32Array(buffer)
      samples.set([0.25, -0.5])
      const pending = api.computeSpeakerEmbedding('/model.onnx', samples, 'live')
      if (change === 'mutate') samples.fill(1)
      else if (change === 'detach') structuredClone(buffer, { transfer: [buffer] })
      else buffer.resize(0)
      try {
        expect(authority.provider).toHaveBeenCalledTimes(1)
        expect(electron.utilityProcess.fork).not.toHaveBeenCalled()
        authority.settle(fullRuntime)
        const sent = await request()
        child.emit('message', { type: 'result', id: sent.id, embedding: new Float32Array(512).buffer })
        await expect(pending).resolves.toHaveLength(512)
        expect([...new Float32Array(sent.pcm as ArrayBuffer)]).toEqual([0.25, -0.5])
      } finally {
        await settleHeldWork(authority, [pending])
      }
    }
  )

  it.each(['embed', 'warmup'] as const)(
    'does not admit %s when same-owner release immediately wins over held authority',
    async (kind) => {
      const authority = await heldRuntimeAuthority()
      const pending = kind === 'embed'
        ? api.computeSpeakerEmbedding('/model.onnx', new Float32Array(1), 'live')
        : api.speakerEmbeddingAvailable('/model.onnx', 'live')
      const stopping = api.releaseSpeakerEmbedding('live')
      try {
        await expect(stopping).resolves.toBe('idle')
        const refused = kind === 'embed' ? expect(pending).rejects.toThrow(/cancelled/i)
          : expect(pending).resolves.toBe(false)
        authority.settle(fullRuntime)
        await refused
        expect(child.postMessage).not.toHaveBeenCalled()
        expect(child.kill).not.toHaveBeenCalled()
        expect(electron.utilityProcess.fork).not.toHaveBeenCalled()
      } finally {
        await settleHeldWork(authority, [pending, stopping])
      }
    }
  )

  it.each([
    ['embed', 'live'], ['embed', 'import'], ['warmup', 'live'], ['warmup', 'import']
  ] as const)(
    'does not admit %s for %s when quit immediately wins over held authority',
    async (kind, owner) => {
      const authority = await heldRuntimeAuthority()
      const pending = kind === 'embed'
        ? api.computeSpeakerEmbedding('/model.onnx', new Float32Array(1), owner)
        : api.speakerEmbeddingAvailable('/model.onnx', owner)
      api.killSpeakerEmbeddingHostForQuit()
      try {
        expect(authority.provider).toHaveBeenCalledTimes(1)
        expect(electron.utilityProcess.fork).not.toHaveBeenCalled()
        const refused = kind === 'embed' ? expect(pending).rejects.toThrow(/cancelled/i)
          : expect(pending).resolves.toBe(false)
        authority.settle(fullRuntime)
        await refused
        expect(child.postMessage).not.toHaveBeenCalled()
        expect(child.kill).not.toHaveBeenCalled()
        expect(electron.utilityProcess.fork).not.toHaveBeenCalled()
      } finally {
        await settleHeldWork(authority, [pending])
      }
    }
  )

  it('bounds all sixteen reservations before authority and restores slots after real refusal', async () => {
    const authority = await heldRuntimeAuthority()
    const pending = Array.from({ length: 16 }, (_, index) => index % 2
      ? api.speakerEmbeddingAvailable('/model.onnx', 'live')
      : api.computeSpeakerEmbedding('/model.onnx', new Float32Array(0), 'live'))
    try {
      await expect(api.speakerEmbeddingAvailable('/model.onnx', 'live')).rejects.toMatchObject({ code: 'SPEAKER_EMBEDDING_BUSY' })
      await expect(api.computeSpeakerEmbedding('/model.onnx', new Float32Array(0), 'live')).rejects.toMatchObject({ code: 'SPEAKER_EMBEDDING_BUSY' })
      expect(authority.provider).toHaveBeenCalledTimes(16)
      expect(electron.utilityProcess.fork).not.toHaveBeenCalled()
      authority.settle(invalidRuntime)
      await expect(Promise.all(pending)).resolves.toEqual(Array.from({ length: 16 }, (_, index) => index % 2 ? false : null))
      authority.settle(fullRuntime)
      const later = api.speakerEmbeddingAvailable('/model.onnx', 'live')
      pending.push(later)
      const sent = await request('warmup')
      child.emit('message', { type: 'result', id: sent.id })
      await expect(later).resolves.toBe(true)
    } finally {
      await settleHeldWork(authority, pending)
    }
  })

  it('holds immutable byte reservations through authority denial and restores them exactly once', async () => {
    const authority = await heldRuntimeAuthority()
    const windows = [new Float32Array(16_000 * 30), new Float32Array(16_000 * 30)]
    const pending = windows.map((samples) => api.computeSpeakerEmbedding('/model.onnx', samples, 'live'))
    for (const samples of windows) structuredClone(samples.buffer, { transfer: [samples.buffer] })
    try {
      await expect(api.computeSpeakerEmbedding('/model.onnx', new Float32Array(1), 'live')).rejects.toMatchObject({ code: 'SPEAKER_EMBEDDING_BUSY' })
      expect(authority.provider).toHaveBeenCalledTimes(2)
      expect(electron.utilityProcess.fork).not.toHaveBeenCalled()
      authority.settle(invalidRuntime)
      await expect(Promise.all(pending)).resolves.toEqual([null, null])
      authority.settle(fullRuntime)
      pending.push(api.computeSpeakerEmbedding('/model.onnx', new Float32Array(16_000 * 30), 'live'))
      pending.push(api.computeSpeakerEmbedding('/model.onnx', new Float32Array(16_000 * 30), 'live'))
      await expect(api.computeSpeakerEmbedding('/model.onnx', new Float32Array(1), 'live')).rejects.toMatchObject({ code: 'SPEAKER_EMBEDDING_BUSY' })
      await request('embed', child, 2)
      for (const [sent] of child.postMessage.mock.calls) {
        child.emit('message', { type: 'result', id: sent.id, embedding: new Float32Array(512).buffer })
      }
      for (const result of await Promise.all(pending.slice(2))) expect(result).toHaveLength(512)
    } finally {
      await settleHeldWork(authority, pending)
    }
  })

  it('preserves malformed-input errors and valid-input null/false refusal without host work', async () => {
    const authority = await heldRuntimeAuthority()
    await expect(api.computeSpeakerEmbedding('/model.onnx', Float32Array.from([NaN]), 'live')).rejects.toThrow(/finite/i)
    expect(authority.provider).not.toHaveBeenCalled()
    const pending = [
      api.computeSpeakerEmbedding('/model.onnx', new Float32Array(1), 'live'),
      api.speakerEmbeddingAvailable('/model.onnx', 'live')
    ]
    try {
      authority.settle(invalidRuntime)
      await expect(Promise.all(pending)).resolves.toEqual([null, false])
      expect(child.postMessage).not.toHaveBeenCalled()
      expect(electron.utilityProcess.fork).not.toHaveBeenCalled()
    } finally {
      await settleHeldWork(authority, pending)
    }
  })

  it('does not make other-owner release wait for unadmitted authority', async () => {
    const authority = await heldRuntimeAuthority()
    const pending = api.computeSpeakerEmbedding('/model.onnx', new Float32Array(1), 'import')
    try {
      await expect(api.releaseSpeakerEmbedding('live')).resolves.toBe('idle')
      expect(authority.provider).toHaveBeenCalledTimes(1)
      expect(electron.utilityProcess.fork).not.toHaveBeenCalled()
      authority.settle(fullRuntime)
      const sent = await request()
      child.emit('message', { type: 'result', id: sent.id, embedding: new Float32Array(512).buffer })
      await expect(pending).resolves.toHaveLength(512)
    } finally {
      await settleHeldWork(authority, [pending])
    }
  })

  it('does not let a pending denied reservation supersede or extend another-owner teardown', async () => {
    const authority = await heldRuntimeAuthority()
    authority.settle(fullRuntime)
    const original = api.computeSpeakerEmbedding('/model.onnx', new Float32Array(1), 'import')
    const originalRequest = await request()
    authority.hold()
    const pending = api.computeSpeakerEmbedding('/model.onnx', new Float32Array(1), 'import')
    const stopping = api.releaseSpeakerEmbedding('live')
    try {
      child.emit('message', { type: 'result', id: originalRequest.id, embedding: new Float32Array(512).buffer })
      await original
      // The new provider promise is still held: only already-authorized host work may delay teardown.
      await vi.waitFor(() => expect(child.kill).toHaveBeenCalledTimes(1))
      child.emit('exit', 0)
      await expect(stopping).resolves.toBe('released')
      authority.settle(invalidRuntime)
      await expect(pending).resolves.toBeNull()
      expect(electron.utilityProcess.fork).toHaveBeenCalledTimes(1)
      expect(child.postMessage).toHaveBeenCalledTimes(1)
    } finally {
      await settleHeldWork(authority, [original, pending, stopping])
    }
  })

  it('admits later authorized other-owner work only after the exact old child exits', async () => {
    const authority = await heldRuntimeAuthority()
    authority.settle(fullRuntime)
    const warm = api.speakerEmbeddingAvailable('/model.onnx', 'live')
    const warmed = await request('warmup')
    child.emit('message', { type: 'result', id: warmed.id })
    await warm
    authority.hold()
    const second = new FakeChild()
    electron.utilityProcess.fork.mockReturnValue(second)
    const pending = api.computeSpeakerEmbedding('/model.onnx', new Float32Array(1), 'import')
    const stopping = api.releaseSpeakerEmbedding('live')
    try {
      await vi.waitFor(() => expect(child.kill).toHaveBeenCalledTimes(1))
      authority.settle(fullRuntime)
      expect(electron.utilityProcess.fork).toHaveBeenCalledTimes(1)
      child.emit('exit', 0)
      await stopping
      const sent = await request('embed', second)
      second.emit('message', { type: 'result', id: sent.id, embedding: new Float32Array(512).buffer })
      await expect(pending).resolves.toHaveLength(512)
      expect(electron.utilityProcess.fork).toHaveBeenCalledTimes(2)
      expect(second.kill).not.toHaveBeenCalled()
    } finally {
      await settleHeldWork(authority, [warm, pending, stopping])
    }
  })

  it('refuses an unconfigured packaged runtime before posting work or forking a child', async () => {
    electron.app.isPackaged = true

    await expect(api.speakerEmbeddingAvailable('/model.onnx', 'live')).resolves.toBe(false)
    await expect(api.computeSpeakerEmbedding('/model.onnx', new Float32Array(16), 'live')).resolves.toBeNull()

    expect(child.postMessage).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
    expect(electron.utilityProcess.fork).not.toHaveBeenCalled()
  })

  it('forks the dedicated host lazily and preserves the caller buffer', async () => {
    const samples = Float32Array.from([0.25, -0.5])
    const original = [...samples]
    expect(electron.utilityProcess.fork).not.toHaveBeenCalled()
    const pending = api.computeSpeakerEmbedding('/model.onnx', samples, 'live')
    const sent = await request()
    expect(electron.utilityProcess.fork.mock.calls[0][0]).toMatch(/speaker-embedding-host\.js$/)
    expect(sent.pcm).not.toBe(samples.buffer)
    child.emit('message', { type: 'result', id: sent.id, embedding: new Float32Array(512).buffer })
    await expect(pending).resolves.toHaveLength(512)
    expect([...samples]).toEqual(original)
  })

  it('validates finite and maximum PCM before spawning', async () => {
    await expect(api.computeSpeakerEmbedding('/model.onnx', Float32Array.from([Number.NaN]), 'live')).rejects.toThrow(/finite/i)
    await expect(api.computeSpeakerEmbedding('/model.onnx', new Float32Array(16_000 * 30 + 1), 'live')).rejects.toThrow(/large/i)
    expect(electron.utilityProcess.fork).not.toHaveBeenCalled()
  })

  it('bounds aggregate admitted PCM before allocating/posting and releases capacity exactly once', async () => {
    const max = new Float32Array(16_000 * 30)
    const a = api.computeSpeakerEmbedding('/model.onnx', max, 'live')
    const first = await request()
    const b = api.computeSpeakerEmbedding('/model.onnx', max, 'live')
    await request('embed', child, 2)
    await expect(api.computeSpeakerEmbedding('/model.onnx', new Float32Array(1), 'live')).rejects.toMatchObject({ code: 'SPEAKER_EMBEDDING_BUSY' })
    expect(child.postMessage).toHaveBeenCalledTimes(2)
    child.emit('message', { type: 'result', id: first.id, embedding: new Float32Array(512).buffer })
    await a
    const third = api.computeSpeakerEmbedding('/model.onnx', new Float32Array(1), 'live')
    await request('embed', child, 3)
    expect(child.postMessage).toHaveBeenCalledTimes(3)
    for (const call of child.postMessage.mock.calls.slice(1)) {
      const sent = call[0] as { id: string }
      child.emit('message', { type: 'result', id: sent.id, embedding: new Float32Array(512).buffer })
    }
    await Promise.all([b, third])
  })

  it('bounds non-PCM warmup requests as well as bytes', async () => {
    const pending = Array.from({ length: 16 }, () => api.speakerEmbeddingAvailable('/model.onnx', 'live'))
    await request('warmup', child, 16)
    expect(child.postMessage).toHaveBeenCalledTimes(16)
    await expect(api.speakerEmbeddingAvailable('/model.onnx', 'live')).rejects.toMatchObject({ code: 'SPEAKER_EMBEDDING_BUSY' })
    for (const [sent] of child.postMessage.mock.calls) {
      child.emit('message', { type: 'result', id: (sent as { id: string }).id })
    }
    await expect(Promise.all(pending)).resolves.toEqual(Array(16).fill(true))
  })

  it('uses immutable byte accounting when the caller detaches its original buffer', async () => {
    const samples = new Float32Array(16_000 * 30)
    const pending = api.computeSpeakerEmbedding('/model.onnx', samples, 'live')
    const sent = await request()
    structuredClone(samples.buffer, { transfer: [samples.buffer] })
    child.emit('message', { type: 'result', id: sent.id, embedding: new Float32Array(512).buffer })
    await pending

    child.postMessage.mockClear()
    const next = api.computeSpeakerEmbedding('/model.onnx', new Float32Array(16_000 * 30), 'live')
    const nextSent = await request('embed')
    child.emit('message', { type: 'result', id: nextSent.id, embedding: new Float32Array(512).buffer })
    await next
  })

  it('uses immutable byte accounting when a resizable caller buffer shrinks', async () => {
    const bytes = 16_000 * 30 * Float32Array.BYTES_PER_ELEMENT
    const ResizableArrayBuffer = ArrayBuffer as unknown as {
      new(byteLength: number, options: { maxByteLength: number }): ArrayBuffer & { resize(size: number): void }
    }
    const buffer = new ResizableArrayBuffer(bytes, { maxByteLength: bytes })
    const samples = new Float32Array(buffer)
    const pending = api.computeSpeakerEmbedding('/model.onnx', samples, 'live')
    const sent = await request()
    buffer.resize(0)
    child.emit('message', { type: 'result', id: sent.id, embedding: new Float32Array(512).buffer })
    await pending

    child.postMessage.mockClear()
    const a = api.computeSpeakerEmbedding('/model.onnx', new Float32Array(16_000 * 30), 'live')
    const b = api.computeSpeakerEmbedding('/model.onnx', new Float32Array(16_000 * 30), 'live')
    await request('embed', child, 2)
    expect(child.postMessage).toHaveBeenCalledTimes(2)
    for (const [request] of child.postMessage.mock.calls) {
      child.emit('message', { type: 'result', id: (request as { id: string }).id, embedding: new Float32Array(512).buffer })
    }
    await Promise.all([a, b])
  })

  it('rejects malformed host embeddings, crashes, and timed-out work', async () => {
    const malformed = api.computeSpeakerEmbedding('/model.onnx', new Float32Array(1), 'live')
    const malformedReq = await request()
    child.emit('message', { type: 'result', id: malformedReq.id, embedding: new Float32Array(2).buffer })
    await expect(malformed).rejects.toThrow(/512/)

    const crashed = api.computeSpeakerEmbedding('/model.onnx', new Float32Array(1), 'live')
    await request('embed', child, 2)
    child.emit('exit', 137)
    await expect(crashed).rejects.toThrow(/exited unexpectedly/i)
  })

  it('times out a hung request and terminates that exact generation', async () => {
    vi.useFakeTimers()
    const pending = api.computeSpeakerEmbedding('/model.onnx', new Float32Array(1), 'live')
    await request()
    const assertion = expect(pending).rejects.toThrow(/timed out/i)
    await vi.advanceTimersByTimeAsync(15_001)
    await assertion
    expect(child.kill).toHaveBeenCalledTimes(1)
    child.emit('exit', 0)
  })

  it('waits for exact exit, blocks overlap on unconfirmed exit, and ignores stale exits', async () => {
    vi.useFakeTimers()
    const warm = api.speakerEmbeddingAvailable('/model.onnx', 'live')
    const warmReq = await request('warmup')
    child.emit('message', { type: 'result', id: warmReq.id })
    await expect(warm).resolves.toBe(true)

    let settled = false
    const release = api.releaseSpeakerEmbedding('live').then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(child.kill).toHaveBeenCalledTimes(1)
    child.emit('exit', 0)
    await release

    const second = new FakeChild()
    electron.utilityProcess.fork.mockReturnValue(second)
    const secondWarm = api.speakerEmbeddingAvailable('/model.onnx', 'live')
    const req = await request('warmup', second)
    second.emit('message', { type: 'result', id: req.id })
    await secondWarm
    const failedRelease = api.releaseSpeakerEmbedding('live')
    const assertion = expect(failedRelease).rejects.toThrow(/could not confirm/i)
    await vi.advanceTimersByTimeAsync(5_001)
    await assertion
    child.emit('exit', 0)
    await expect(api.computeSpeakerEmbedding('/model.onnx', new Float32Array(1), 'live')).rejects.toThrow(/could not confirm/i)
    expect(electron.utilityProcess.fork).toHaveBeenCalledTimes(2)
  })

  it('waits for the other owner before killing, then confirms the exact child exit', async () => {
    const importing = api.computeSpeakerEmbedding('/model.onnx', new Float32Array(4), 'import')
    const req = await request()
    let settled = false
    const release = api.releaseSpeakerEmbedding('live').then((result) => { settled = true; return result })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(child.kill).not.toHaveBeenCalled()
    child.emit('message', { type: 'result', id: req.id, embedding: new Float32Array(512).buffer })
    await importing
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledTimes(1))
    expect(child.kill).toHaveBeenCalledTimes(1)
    child.emit('exit', 0)
    await expect(release).resolves.toBe('released')
  })

  it('does not let later other-owner admission extend or get killed by an older release', async () => {
    const original = api.computeSpeakerEmbedding('/model.onnx', new Float32Array(4), 'import')
    const originalReq = await request()
    let releaseResult: string | undefined
    const oldStop = api.releaseSpeakerEmbedding('live').then((result) => {
      releaseResult = result
      return result
    })

    const replacement = api.computeSpeakerEmbedding('/model.onnx', new Float32Array(4), 'import')
    const replacementReq = await request('embed', child, 2)

    child.emit('message', { type: 'result', id: originalReq.id, embedding: new Float32Array(512).buffer })
    await original
    await expect(oldStop).resolves.toBe('superseded')

    // The release owns only the work admitted when it began. A newer import request supersedes it;
    // waiting for global future idleness would leave this unset until replacement also finishes.
    expect(releaseResult).toBe('superseded')
    expect(child.kill).not.toHaveBeenCalled()

    child.emit('message', { type: 'result', id: replacementReq.id, embedding: new Float32Array(512).buffer })
    await replacement
    await expect(oldStop).resolves.toBe('superseded')
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('does not let an old teardown kill work admitted by a replacement session', async () => {
    const importing = api.computeSpeakerEmbedding('/model.onnx', new Float32Array(4), 'import')
    const importReq = await request()
    const oldStop = api.releaseSpeakerEmbedding('live')
    const replacement = api.computeSpeakerEmbedding('/model.onnx', new Float32Array(4), 'live')
    const liveReq = await request('embed', child, 2)

    child.emit('message', { type: 'result', id: importReq.id, embedding: new Float32Array(512).buffer })
    await importing
    await expect(oldStop).resolves.toBe('superseded')
    expect(child.kill).not.toHaveBeenCalled()

    child.emit('message', { type: 'result', id: liveReq.id, embedding: new Float32Array(512).buffer })
    await replacement
    const finalRelease = api.releaseSpeakerEmbedding('live')
    child.emit('exit', 0)
    await finalRelease
  })
})
