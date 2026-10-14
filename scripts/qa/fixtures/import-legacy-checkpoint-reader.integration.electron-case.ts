import { createCipheriv, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  ImportLegacyBounds,
  ImportLegacySourceAdmission,
  ImportOperationScope,
  OpaqueTranscriptHandle
} from '../../../src/main/import-legacy-checkpoint-contract'
import { createImportLegacyCheckpointReader } from '../../../src/main/import-legacy-checkpoint-reader'
import { createImportLegacyCheckpointHost } from '../../../src/main/infra/process/import-legacy-checkpoint-host'
import type { LegacyOutput } from '../../../src/main/import-legacy-checkpoint-protocol'

const bounds: ImportLegacyBounds = {
  maxPhysicalBytes: 32_768,
  maxDecodedBytes: 16_384,
  maxDescriptorBytes: 2_048,
  maxHeaderBytes: 4_096,
  maxChunkBytes: 4_096,
  maxResidentBytes: 65_536,
  maxStagingBytes: 65_536,
  maxGlobalResidentBytes: 65_536,
  maxGlobalStagingBytes: 65_536,
  maxGlobalReadSlots: 1,
  maxGlobalWriteSlots: 1,
  maxGlobalCredits: 1,
  maxGlobalSettlingOperations: 1,
  maxRecords: 4,
  maxWords: 16,
  maxFieldBytes: 1_024,
  maxRecordBytes: 2_048,
  maxPayloadBytes: 4_096,
  operationDeadlineMs: 5_000,
  shutdownDeadlineMs: 2_000,
  nativeV1: { unavailable: true }
}

const fixture = {
  jobId: '7a29e174-80f0-4f32-b97e-2cc9c8c80b77',
  sourcePath: '/synthetic/meeting.wav',
  sourceName: 'meeting.wav',
  sourceSizeBytes: 99,
  sourceMtimeMs: 1_700_000_000_000,
  title: 'Worker fixture',
  state: 'transcribing',
  cursor: 1,
  totalChunks: 1,
  pipeline: 'vad-v2',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_100,
  lines: [{ speaker: 'you', text: 'compiled bounded record', t: 1_700_000_000_001 }]
}

async function coordinatorRead(sourceBytes: Buffer, key?: Uint8Array) {
  const version = {
    dev: 1,
    ino: 2,
    nlink: 1,
    size: sourceBytes.byteLength,
    mtimeMs: 3,
    ctimeMs: 4
  }
  const scope = Object.freeze({}) as ImportOperationScope
  const records: string[] = []
  let published = 0
  let aborted = 0
  let maxReadRequest = 0
  const reader = createImportLegacyCheckpointReader({
    authority: { assertCurrent: () => {}, refreshSameScope: async () => {} },
    resources: {
      acquire: async () => ({ settled: async () => {}, quarantine: () => {} })
    },
    source: {
      open: async () => ({
        version,
        readAt: async (position, target, expected, _scope, guard) => {
          guard.assertCurrent()
          expect(expected).toEqual(version)
          maxReadRequest = Math.max(maxReadRequest, target.byteLength)
          const length = Math.min(3, target.byteLength, sourceBytes.byteLength - position)
          target.set(sourceBytes.subarray(position, position + length))
          guard.assertCurrent()
          return length
        },
        requestCancel: () => {},
        assertCurrentVersion: async (expected) => expect(expected).toEqual(version),
        admitOriginalSource: async () => ({ assertCurrent: () => {} }) as ImportLegacySourceAdmission,
        close: async () => {},
        settled: async () => {}
      })
    },
    keys: {
      unwrapV2: async (_descriptor, admission) => {
        admission.assertCurrent()
        if (!key) throw new Error('A key was not provided for this V2 fixture.')
        return new Uint8Array(key)
      }
    },
    candidate: {
      begin: async () => ({
        append: async (recordJson) => {
          records.push(new TextDecoder().decode(recordJson))
        },
        requestAbortOwnedCandidate: () => {},
        abortOwnedCandidate: async () => {
          aborted += 1
        },
        publish: async (_header, _totals, admission, guard) => {
          admission.assertCurrent()
          guard.assertCurrent()
          published += 1
          return Object.freeze({}) as OpaqueTranscriptHandle
        }
      })
    },
    createWorker: () =>
      createImportLegacyCheckpointHost({
        entryPath: join(process.cwd(), 'out/main/import-legacy-checkpoint-worker.js')
      }),
    bounds: () => bounds
  })
  const result = await reader(fixture.jobId, scope)
  return { result, records, published, aborted, maxReadRequest }
}

describe('compiled Electron legacy checkpoint worker', () => {
  it('streams one record under credit, then settles the compiled worker exactly', async () => {
    expect(process.versions.electron).toBe('43.6.0')
    const worker = await createImportLegacyCheckpointHost({
      entryPath: join(process.cwd(), 'out/main/import-legacy-checkpoint-worker.js')
    })
    const queue: unknown[] = []
    let pending: ((value: unknown) => void) | undefined
    worker.onMessage((value) => {
      if (pending) {
        const resolve = pending
        pending = undefined
        resolve(value)
      } else queue.push(value)
    })
    const next = (): Promise<LegacyOutput> =>
      queue.length
        ? Promise.resolve(queue.shift() as LegacyOutput)
        : new Promise((resolve) => {
            pending = (value) => resolve(value as LegacyOutput)
          })
    const sessionId = 'legacy-worker-positive'
    try {
      worker.post({ protocol: 1, op: 'open', sessionId, format: 'plain', bounds })
      expect(await next()).toMatchObject({ type: 'input-credit', nextSequence: 0 })
      const encoded = new TextEncoder().encode(JSON.stringify(fixture))
      const owned = new Uint8Array(encoded.byteLength)
      owned.set(encoded)
      worker.post({ protocol: 1, op: 'chunk', sessionId, sequence: 0, bytes: owned }, [owned.buffer])
      expect(owned.byteLength).toBe(0)
      const record = await next()
      expect(record).toMatchObject({ type: 'record', recordSequence: 0 })
      if (record.type !== 'record') throw new Error('Compiled worker did not return a record.')
      expect(new TextDecoder().decode(record.recordJson)).toBe(JSON.stringify(fixture.lines[0]))
      worker.post({ protocol: 1, op: 'record-ack', sessionId, recordSequence: 0 })
      expect(await next()).toMatchObject({ type: 'input-credit', nextSequence: 1 })
      worker.post({ protocol: 1, op: 'end', sessionId })
      const completed = await next()
      expect(completed).toMatchObject({
        type: 'complete',
        header: { jobId: fixture.jobId },
        totals: { records: 1, words: 3 }
      })
    } finally {
      await worker.terminate()
    }
  })

  it('scans and decrypts the real ATKENC2 shape in two compiled worker passes', async () => {
    expect(process.versions.electron).toBe('43.6.0')
    const key = randomBytes(32)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const plaintext = Buffer.from(JSON.stringify(fixture))
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const envelopeText = JSON.stringify({
      v: 2,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ct: ciphertext.toString('base64'),
      kLocal: 'F:compiled-worker-fixture'
    })
      .replace(
        /("ct":")([^"]*)(")/,
        (_match, prefix: string, base64: string, suffix: string) => `${prefix}${base64.replaceAll('/', '\\/')}${suffix}`
      )
      .replace('"kLocal":', '"k\\u004cocal":')
    const envelope = Buffer.from(envelopeText)

    const scanWorker = await createImportLegacyCheckpointHost({
      entryPath: join(process.cwd(), 'out/main/import-legacy-checkpoint-worker.js')
    })
    const scanQueue: LegacyOutput[] = []
    let scanPending: ((value: LegacyOutput) => void) | undefined
    scanWorker.onMessage((raw) => {
      const value = raw as LegacyOutput
      if (scanPending) {
        const resolve = scanPending
        scanPending = undefined
        resolve(value)
      } else scanQueue.push(value)
    })
    const nextScan = (): Promise<LegacyOutput> =>
      scanQueue.length
        ? Promise.resolve(scanQueue.shift()!)
        : new Promise((resolve) => {
            scanPending = resolve
          })
    try {
      const sessionId = 'legacy-v2-scan'
      scanWorker.post({ protocol: 1, op: 'open', sessionId, format: 'v2-scan', bounds })
      expect(await nextScan()).toMatchObject({ type: 'input-credit', nextSequence: 0 })
      const chunk = new Uint8Array(envelope)
      scanWorker.post({ protocol: 1, op: 'chunk', sessionId, sequence: 0, bytes: chunk }, [chunk.buffer])
      expect(await nextScan()).toMatchObject({ type: 'input-credit', nextSequence: 1 })
      scanWorker.post({ protocol: 1, op: 'end', sessionId })
      const scan = await nextScan()
      expect(scan.type).toBe('scan-complete')
      if (scan.type !== 'scan-complete') throw new Error('Compiled v2 scan did not complete.')

      const decryptWorker = await createImportLegacyCheckpointHost({
        entryPath: join(process.cwd(), 'out/main/import-legacy-checkpoint-worker.js')
      })
      const decryptQueue: LegacyOutput[] = []
      let decryptPending: ((value: LegacyOutput) => void) | undefined
      decryptWorker.onMessage((raw) => {
        const value = raw as LegacyOutput
        if (decryptPending) {
          const resolve = decryptPending
          decryptPending = undefined
          resolve(value)
        } else decryptQueue.push(value)
      })
      const nextDecrypt = (): Promise<LegacyOutput> =>
        decryptQueue.length
          ? Promise.resolve(decryptQueue.shift()!)
          : new Promise((resolve) => {
              decryptPending = resolve
            })
      try {
        const sessionId = 'legacy-v2-decrypt'
        decryptWorker.post({ protocol: 1, op: 'open', sessionId, format: 'v2-decrypt', bounds })
        expect(await nextDecrypt()).toMatchObject({ type: 'input-credit', nextSequence: 0 })
        const keyTransfer = new Uint8Array(key)
        decryptWorker.post({ protocol: 1, op: 'key', sessionId, descriptor: scan.descriptor, key: keyTransfer }, [
          keyTransfer.buffer
        ])
        expect(keyTransfer.byteLength).toBe(0)
        const chunk = new Uint8Array(envelope)
        decryptWorker.post({ protocol: 1, op: 'chunk', sessionId, sequence: 0, bytes: chunk }, [chunk.buffer])
        const record = await nextDecrypt()
        expect(record.type).toBe('record')
        if (record.type !== 'record')
          throw new Error('Compiled v2 worker did not return an authenticated candidate record.')
        expect(new TextDecoder().decode(record.recordJson)).toBe(JSON.stringify(fixture.lines[0]))
        decryptWorker.post({ protocol: 1, op: 'record-ack', sessionId, recordSequence: 0 })
        expect(await nextDecrypt()).toMatchObject({ type: 'input-credit', nextSequence: 1 })
        decryptWorker.post({ protocol: 1, op: 'end', sessionId })
        expect(await nextDecrypt()).toMatchObject({ type: 'complete', totals: { records: 1, words: 3 } })
      } finally {
        await decryptWorker.terminate()
      }
    } finally {
      await scanWorker.terminate()
      key.fill(0)
    }
  })

  it('publishes a plain coordinator result through partial guarded reads and one-record appends', async () => {
    const source = Buffer.from(JSON.stringify(fixture))
    const result = await coordinatorRead(source)
    expect(result.result).toMatchObject({ status: 'ready', header: { jobId: fixture.jobId } })
    expect(result.records).toEqual([JSON.stringify(fixture.lines[0])])
    expect(result.published).toBe(1)
    expect(result.aborted).toBe(0)
    expect(result.maxReadRequest).toBeLessThanOrEqual(bounds.maxChunkBytes)
  })

  it('aborts a private V2 candidate when final GCM authentication fails after early record appends', async () => {
    const key = randomBytes(32)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const plaintext = Buffer.from(JSON.stringify(fixture))
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const tag = cipher.getAuthTag()
    tag[0] ^= 1
    const envelope = Buffer.from(
      `ATKENC2\n${JSON.stringify({
        v: 2,
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        ct: ciphertext.toString('base64'),
        kLocal: 'F:compiled-private-candidate'
      })}`
    )
    try {
      const result = await coordinatorRead(envelope, key)
      expect(result.result).toMatchObject({ status: 'refused' })
      expect(result.records).toEqual([JSON.stringify(fixture.lines[0])])
      expect(result.published).toBe(0)
      expect(result.aborted).toBe(1)
    } finally {
      key.fill(0)
    }
  })
})
