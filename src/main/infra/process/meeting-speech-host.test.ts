import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { TranscriptLine } from '@shared/transcript-line'
import type { MeetingSpeechRequest } from './meeting-speech-protocol'
import { createMeetingSpeechPersistenceService, type MeetingSpeechWorkerPort } from './meeting-speech-host'
import { processMeetingSpeechRequest } from '../../meeting-speech-worker'
import {
  consumeIncrementalRecordReceipt,
  type IncrementalRecordReceiptBinding
} from './incremental-record-receipt'

const policy = {
  limits: { maxRecords: 4, maxWords: 4, maxFieldBytes: 1024, maxRecordBytes: 4096, maxPayloadBytes: 8192 },
  maxInputBytes: 16_384,
  maxOutputBytes: 16_384,
  operationDeadlineMs: 2_000,
  shutdownDeadlineMs: 2_000
}

function receiptBinding(meetingId = '64d5a603-0b18-4da5-8a3f-4a42c9d22031'): IncrementalRecordReceiptBinding {
  return {
    ownerToken: Object.freeze(Object.create(null) as object),
    meetingId,
    isCurrent: () => true,
    limits: policy.limits,
    maxCanonicalBytes: policy.maxOutputBytes
  }
}

class TestWorker extends EventEmitter implements MeetingSpeechWorkerPort {
  readonly requests: MeetingSpeechRequest[] = []
  readonly delay: number
  constructor(delay = 0) {
    super()
    this.delay = delay
  }
  postMessage(request: MeetingSpeechRequest): void {
    this.requests.push(request)
    if (this.delay < 0) return
    setTimeout(() => {
      const reply = processMeetingSpeechRequest(request)
      if (reply) this.emit('message', reply)
    }, this.delay)
  }
  async terminate(): Promise<number> {
    this.emit('exit', 1)
    return 1
  }
}

class TamperedCanonicalWorker extends TestWorker {
  readonly mutation: 'metadata' | 'bytes'
  constructor(mutation: 'metadata' | 'bytes') {
    super()
    this.mutation = mutation
  }
  override postMessage(request: MeetingSpeechRequest): void {
    this.requests.push(request)
    const reply = processMeetingSpeechRequest(request)
    const result = reply?.result as
      | { ok?: boolean; value?: { canonicalBytes?: Uint8Array; sha256?: string } }
      | undefined
    if (result?.ok && result.value) {
      if (this.mutation === 'metadata') result.value.sha256 = '0'.repeat(64)
      else if (result.value.canonicalBytes) result.value.canonicalBytes[0] ^= 1
    }
    if (reply) this.emit('message', reply)
  }
}

class HeldExitWorker extends EventEmitter implements MeetingSpeechWorkerPort {
  terminated = false
  postMessage(): void {}
  async terminate(): Promise<number> {
    this.terminated = true
    return 1
  }
}

class NeverTerminateWorker extends EventEmitter implements MeetingSpeechWorkerPort {
  terminated = false
  postMessage(): void {}
  terminate(): Promise<number> {
    this.terminated = true
    return new Promise(() => {})
  }
}

describe('meeting speech persistence worker host', () => {
  it('does not create a child before a bounded request is admitted', async () => {
    let starts = 0
    const service = createMeetingSpeechPersistenceService({
      readLimits: () => undefined,
      readBounds: () => policy,
      workerFactory: () => {
        starts++
        return new TestWorker()
      }
    })
    await expect(service.render([])).rejects.toMatchObject({ name: 'UNCONFIGURED' })
    expect(starts).toBe(0)
    await service.dispose()
  })

  it('rejects a huge sparse array before expanding it into the admission traversal stack', async () => {
    let starts = 0
    const service = createMeetingSpeechPersistenceService({
      readLimits: () => policy.limits,
      readBounds: () => policy,
      workerFactory: () => {
        starts++
        return new TestWorker()
      }
    })
    const huge = new Array(1_000_000) as never
    await expect(service.render(huge)).rejects.toMatchObject({ name: 'RESOURCE_LIMIT' })
    expect(starts).toBe(0)
    await service.dispose()
  })

  it('uses the worker codec for a typed projection and preserves the closed result shape', async () => {
    const worker = new TestWorker()
    const service = createMeetingSpeechPersistenceService({
      readLimits: () => policy.limits,
      readBounds: () => policy,
      workerFactory: () => worker
    })
    await expect(service.project('Private metadata')).resolves.toBe('Private metadata')
    expect(worker.requests).toHaveLength(1)
    expect(Object.keys(worker.requests[0]).sort()).toEqual([
      'generation',
      'id',
      'input',
      'operation',
      'policy',
      'protocol'
    ])
    await service.dispose()
  })

  it('canonicalizes one retained record in the worker under an explicit current owner', async () => {
    const worker = new TestWorker()
    const recordBytes = new TextEncoder().encode(
      JSON.stringify({
        identity: { kind: 'local', recordId: '6370e1cc-43f4-4976-a912-04d0c3ca8f9f' },
        source: 'local-final',
        line: { speaker: 'you', text: 'one bounded record', t: 1_700_000_000_000 }
      })
    )
    // The service transfers recordBytes; the admitted budget must survive that buffer's detachment.
    const maxInputBytes = recordBytes.byteLength
    const service = createMeetingSpeechPersistenceService({
      readLimits: () => policy.limits,
      readBounds: () => ({ ...policy, maxInputBytes }),
      isCurrent: () => true,
      workerFactory: () => worker
    })
    const binding = receiptBinding()
    const receipt = await service.canonicalizeIncrementalRecord(recordBytes, binding)
    expect(recordBytes.byteLength).toBe(0)
    expect(worker.requests[0].policy.maxInputBytes).toBe(maxInputBytes)
    expect(consumeIncrementalRecordReceipt({ ...receipt }, binding)).toBeNull()
    const result = consumeIncrementalRecordReceipt(receipt, binding)
    expect(consumeIncrementalRecordReceipt(receipt, binding)).toBeNull()
    expect(result).not.toBeNull()
    if (!result) return

    expect(worker.requests).toHaveLength(1)
    expect(worker.requests[0].operation).toBe('canonical-record')
    expect(result.identityKey).toBe('{"kind":"local","recordId":"6370e1cc-43f4-4976-a912-04d0c3ca8f9f"}')
    expect(Buffer.from(result.canonicalBytes).toString('utf8')).toContain('one bounded record')
    expect(result.canonicalBytes.byteOffset).toBe(0)
    expect(result.canonicalBytes.byteLength).toBe(result.canonicalByteLength)
    await service.dispose()
  })

  it.each(['metadata', 'bytes'] as const)('refuses a worker receipt with tampered %s', async (mutation) => {
    const worker = new TamperedCanonicalWorker(mutation)
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        identity: { kind: 'local', recordId: '6370e1cc-43f4-4976-a912-04d0c3ca8f9f' },
        source: 'local-final',
        line: { speaker: 'you', text: 'tamper', t: 1_700_000_000_000 }
      })
    )
    const maxInputBytes = bytes.byteLength
    const service = createMeetingSpeechPersistenceService({
      readLimits: () => policy.limits,
      readBounds: () => ({ ...policy, maxInputBytes }),
      isCurrent: () => true,
      workerFactory: () => worker
    })
    await expect(service.canonicalizeIncrementalRecord(bytes, receiptBinding())).rejects.toMatchObject({
      name: 'WORKER_FAILED'
    })
    expect(bytes.byteLength).toBe(0)
    expect(worker.requests[0].policy.maxInputBytes).toBe(maxInputBytes)
    await service.dispose()
  })

  it('invalidates an unconsumed worker receipt when its bound owner retires', async () => {
    let current = true
    const isCurrent = () => current
    const worker = new TestWorker()
    const service = createMeetingSpeechPersistenceService({
      readLimits: () => policy.limits,
      readBounds: () => ({ ...policy, maxInputBytes: 16_384 }),
      isCurrent,
      workerFactory: () => worker
    })
    const binding = { ...receiptBinding(), isCurrent }
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        identity: { kind: 'local', recordId: '6370e1cc-43f4-4976-a912-04d0c3ca8f9f' },
        source: 'local-final',
        line: { speaker: 'you', text: 'owned', t: 1_700_000_000_000 }
      })
    )
    const receipt = await service.canonicalizeIncrementalRecord(bytes, binding)
    current = false
    expect(consumeIncrementalRecordReceipt(receipt, binding)).toBeNull()
    await service.dispose()
  })

  it('accepts a valid canonical worker result at the exact admitted record-byte ceiling', () => {
    const recordJson = new TextEncoder().encode(
      JSON.stringify({
        identity: { kind: 'local', recordId: '6370e1cc-43f4-4976-a912-04d0c3ca8f9f' },
        source: 'local-final',
        line: { speaker: 'you', text: 'one bounded record', t: 1_700_000_000_000 }
      })
    )
    const request: MeetingSpeechRequest = {
      protocol: 1,
      id: 1,
      generation: 1,
      operation: 'canonical-record',
      policy: { ...policy, maxInputBytes: recordJson.byteLength },
      input: { recordJson }
    }

    const reply = processMeetingSpeechRequest(request)

    expect(reply).toMatchObject({ result: { ok: true } })
  })

  it('keeps incremental record canonicalization unavailable without a configured current-owner predicate', async () => {
    let starts = 0
    const service = createMeetingSpeechPersistenceService({
      readLimits: () => policy.limits,
      readBounds: () => policy,
      workerFactory: () => {
        starts++
        return new TestWorker()
      }
    })
    await expect(
      service.canonicalizeIncrementalRecord(
        new TextEncoder().encode(
          JSON.stringify({
            identity: { kind: 'local', recordId: '6370e1cc-43f4-4976-a912-04d0c3ca8f9f' },
            source: 'local-final',
            line: { speaker: 'you', text: 'closed', t: 1_700_000_000_000 }
          })
        ),
        receiptBinding()
      )
    ).rejects.toMatchObject({ name: 'UNCONFIGURED' })
    expect(starts).toBe(0)
    await service.dispose()
  })

  it('rejects borrowed byte views before worker admission', async () => {
    const worker = new TestWorker()
    const service = createMeetingSpeechPersistenceService({
      readLimits: () => policy.limits,
      readBounds: () => policy,
      isCurrent: () => true,
      workerFactory: () => worker
    })
    const borrowed = new TextEncoder().encode('x{"record":true}').subarray(1)
    await expect(service.canonicalizeIncrementalRecord(borrowed, receiptBinding())).rejects.toMatchObject({
      name: 'RESOURCE_LIMIT'
    })
    expect(worker.requests).toHaveLength(0)
    await service.dispose()
  })

  it('admits one active and one queued request, refusing overflow without dispatch', async () => {
    const worker = new TestWorker(-1)
    const service = createMeetingSpeechPersistenceService({
      readLimits: () => policy.limits,
      readBounds: () => policy,
      workerFactory: () => worker
    })
    const first = service.project('one')
    const second = service.project('two')
    await expect(service.project('three')).rejects.toMatchObject({ name: 'QUEUE_FULL' })
    expect(worker.requests).toHaveLength(1)
    await service.invalidateCurrent()
    await expect(first).rejects.toMatchObject({ name: 'CANCELLED' })
    await expect(second).rejects.toMatchObject({ name: 'CANCELLED' })
  })

  it('keeps queued caller input and policy immutable after admission', async () => {
    const worker = new TestWorker(10)
    const mutableLimits = { ...policy.limits }
    const service = createMeetingSpeechPersistenceService({
      readLimits: () => mutableLimits,
      readBounds: () => policy,
      workerFactory: () => worker
    })
    const first = service.project('active')
    const lines: TranscriptLine[] = [{ speaker: 'them', text: 'before admission', t: 1 }]
    const queued = service.rewrite('plain text', lines)
    lines[0].text = 'mutated after admission'
    mutableLimits.maxRecords = 1

    await expect(first).resolves.toBe('active')
    await expect(queued).resolves.toBeNull()
    const request = worker.requests[1]
    expect(request.policy.limits.maxRecords).toBe(policy.limits.maxRecords)
    expect((request.input as { lines: TranscriptLine[] }).lines[0].text).toBe('before admission')
    await service.dispose()
  })

  it('terminates and waits for the exact child exit before releasing an invalidated operation', async () => {
    const worker = new TestWorker(-1)
    const service = createMeetingSpeechPersistenceService({
      readLimits: () => policy.limits,
      readBounds: () => policy,
      workerFactory: () => worker
    })
    const pending = service.project('held')
    await service.invalidateCurrent()
    await expect(pending).rejects.toMatchObject({ name: 'CANCELLED' })
    expect(worker.listenerCount('exit')).toBeGreaterThan(0)
    const retry = new TestWorker()
    const next = createMeetingSpeechPersistenceService({
      readLimits: () => policy.limits,
      readBounds: () => policy,
      workerFactory: () => retry
    })
    await expect(next.project('fresh')).resolves.toBe('fresh')
    await next.dispose()
  })

  it('worker validates operation and refuses an input beyond its transferred budget', () => {
    const request: MeetingSpeechRequest = {
      protocol: 1,
      id: 1,
      generation: 1,
      operation: 'project',
      policy: { ...policy, maxInputBytes: 2 },
      input: 'larger'
    }
    expect(processMeetingSpeechRequest(request)).toMatchObject({ result: { ok: false, code: 'RESOURCE_LIMIT' } })
    expect(processMeetingSpeechRequest({ ...request, operation: 'unsafe' })).toBeNull()
  })

  it('offloads AES-GCM envelope payload encryption and decryption with exact transferable keys', async () => {
    const worker = new TestWorker()
    const service = createMeetingSpeechPersistenceService({
      readLimits: () => policy.limits,
      readBounds: () => policy,
      workerFactory: () => worker
    })
    const key = Uint8Array.from({ length: 32 }, (_, index) => index)
    const iv = Uint8Array.from({ length: 12 }, (_, index) => index + 1)
    const envelope = await service.encryptEnvelopeV2('bounded payload', key, iv, 'F:wrapped-key')
    expect(envelope.subarray(0, 8).toString('utf8')).toBe('ATKENC2\n')
    const parsed = JSON.parse(envelope.subarray(8).toString('utf8')) as {
      ct: string
      iv: string
      tag: string
      kLocal: string
    }
    expect(parsed.kLocal).toBe('F:wrapped-key')
    await expect(service.decryptEnvelopeV2(envelope.subarray(8), key, parsed.kLocal)).resolves.toBe('bounded payload')
    const rewrapped = await service.rewrapEnvelopeV2(envelope.subarray(8), 'F:rotated-key')
    expect(JSON.parse(rewrapped.toString('utf8')).kLocal).toBe('F:rotated-key')
    const mismatchedDescriptor = processMeetingSpeechRequest({
      protocol: 1,
      id: 100,
      generation: 1,
      operation: 'decrypt-v2',
      policy,
      input: {
        envelopeJson: Uint8Array.from(envelope.subarray(8)),
        contentKey: Uint8Array.from(key),
        kLocal: 'F:another-key'
      }
    })
    expect(mismatchedDescriptor?.result).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
    expect(worker.requests.map((request) => request.operation)).toEqual(['encrypt-v2', 'decrypt-v2', 'rewrap-v2'])
    const encryptedRequest = worker.requests[0].input as { contentKey: Uint8Array; iv: Uint8Array }
    expect([...encryptedRequest.contentKey]).toEqual(Array(32).fill(0))
    expect([...encryptedRequest.iv]).toEqual(Array(12).fill(0))
    await service.dispose()
  })

  it('rejects an oversized envelope before copying its bytes into an owned request buffer', async () => {
    let iterationCount = 0
    const envelopeJson = {
      byteLength: 3,
      [Symbol.iterator]: function* () {
        iterationCount++
        throw new Error('oversized envelope was copied')
      }
    } as unknown as Uint8Array
    const service = createMeetingSpeechPersistenceService({
      readLimits: () => policy.limits,
      readBounds: () => ({ ...policy, maxInputBytes: 2 }),
      workerFactory: () => new TestWorker()
    })
    await expect(service.rewrapEnvelopeV2(envelopeJson, 'F:key')).rejects.toMatchObject({ name: 'RESOURCE_LIMIT' })
    expect(iterationCount).toBe(0)
    await service.dispose()
  })

  it('settles queued work at the active deadline while retaining a non-exited worker slot', async () => {
    const worker = new HeldExitWorker()
    const service = createMeetingSpeechPersistenceService({
      readLimits: () => policy.limits,
      readBounds: () => ({ ...policy, operationDeadlineMs: 10, shutdownDeadlineMs: 100 }),
      workerFactory: () => worker
    })
    const active = service.project('held')
    const queued = service.project('queued')
    await expect(active).rejects.toMatchObject({ name: 'WORKER_FAILED' })
    await expect(queued).rejects.toMatchObject({ name: 'CANCELLED' })
    expect(worker.terminated).toBe(true)
    await expect(service.project('while stopping')).rejects.toMatchObject({ name: 'CANCELLED' })
    worker.emit('exit', 1)
    await service.dispose()
  })

  it('bounds unresolved termination and retains the slot until the exact child exit', async () => {
    const worker = new NeverTerminateWorker()
    const replacement = new TestWorker()
    let starts = 0
    const service = createMeetingSpeechPersistenceService({
      readLimits: () => policy.limits,
      readBounds: () => ({ ...policy, shutdownDeadlineMs: 10 }),
      workerFactory: () => (starts++ === 0 ? worker : replacement)
    })
    const active = service.project('active')
    const queued = service.project('queued')
    const activeCancelled = expect(active).rejects.toMatchObject({ name: 'CANCELLED' })
    const queuedCancelled = expect(queued).rejects.toMatchObject({ name: 'CANCELLED' })
    const invalidationFailed = expect(service.invalidateCurrent()).rejects.toMatchObject({ name: 'WORKER_FAILED' })
    await Promise.all([activeCancelled, queuedCancelled, invalidationFailed])
    expect(worker.terminated).toBe(true)
    await expect(service.project('while stopping')).rejects.toMatchObject({ name: 'CANCELLED' })

    worker.emit('exit', 1)
    await expect(service.project('after exact exit')).resolves.toBe('after exact exit')
    expect(starts).toBe(2)
    await service.dispose()
  })

  it('discards a late receipt after main ownership changes', async () => {
    const worker = new TestWorker(10)
    let current = true
    const service = createMeetingSpeechPersistenceService({
      readLimits: () => policy.limits,
      readBounds: () => policy,
      isCurrent: () => current,
      workerFactory: () => worker
    })
    const pending = service.project('held')
    current = false
    await expect(pending).rejects.toMatchObject({ name: 'CANCELLED' })
    await service.dispose()
  })
})
