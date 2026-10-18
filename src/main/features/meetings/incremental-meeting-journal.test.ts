import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import type { SpeechProvenanceLimits } from '@shared/meeting-speech-contract'
import { IncrementalMeetingRecordSchema, type CanonicalIncrementalRecord } from '@shared/incremental-meeting'
import {
  createIncrementalMeetingAppender,
  provenancePayloadBytes,
  type IncrementalJournalSnapshot,
  type IncrementalMeetingJournalStorage
} from './incremental-meeting-journal'
import {
  discardIncrementalRecordReceipt,
  issueIncrementalRecordReceipt,
  type IncrementalRecordReceipt
} from '../../infra/storage/incremental-record-receipt'

const meetingId = '64d5a603-0b18-4da5-8a3f-4a42c9d22031'
const localRecordId = '6370e1cc-43f4-4976-a912-04d0c3ca8f9f'
const recordJson = new TextEncoder().encode(
  JSON.stringify({
    identity: { kind: 'local', recordId: localRecordId },
    source: 'local-final',
    line: { speaker: 'you', text: 'one', t: 1_700_000_000_000 }
  })
)
const provenanceLimits: SpeechProvenanceLimits = {
  maxRecords: 3,
  maxWords: 4,
  maxFieldBytes: 1_024,
  maxRecordBytes: 2_048,
  maxPayloadBytes: 8_192
}
const limits: SpeechProvenanceLimits & { maxJournalBytes: number } = {
  ...provenanceLimits,
  maxJournalBytes: 16_384
}

function snapshot(patch: Partial<IncrementalJournalSnapshot> = {}): IncrementalJournalSnapshot {
  return {
    state: 'active',
    acceptedRevision: 0,
    durableRevision: 0,
    recordCount: 0,
    wordCount: 0,
    linePayloadBytes: 0,
    storedBytes: 0,
    ...patch
  }
}

function canonical(text = 'one', wordCount = 0): CanonicalIncrementalRecord {
  const captureId = '98d9177d-95a1-49f2-8433-22ba7308dc08'
  const identity = wordCount
    ? {
        kind: 'cloud',
        captureId,
        captureGeneration: 7,
        streamGeneration: 7,
        track: 'microphone',
        epoch: 11,
        segmentIndex: 4
      }
    : { kind: 'local', recordId: localRecordId }
  const line = wordCount
    ? {
        speaker: 'them',
        text,
        t: 1_700_000_000_000,
        speech: {
          type: 'segment',
          captureId,
          captureGeneration: 7,
          sequence: 1,
          segment: {
            stream: { generation: 7, track: 'microphone', epoch: 11 },
            engine: 'deepgram-nova3',
            index: 4,
            revision: 1,
            startMs: 0,
            endMs: 500,
            final: true,
            text
          },
          words: Array.from({ length: wordCount }, (_, index) => ({
            text: 'word',
            startMs: index,
            endMs: index + 1
          }))
        }
      }
    : { speaker: 'you', text, t: 1_700_000_000_000 }
  const record = IncrementalMeetingRecordSchema.parse({
    identity,
    source: wordCount ? 'cloud-final' : 'local-final',
    line
  })
  const canonicalText = JSON.stringify(record).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')
  const canonicalBytes = new TextEncoder().encode(canonicalText)
  return {
    identityKey: JSON.stringify(record.identity),
    sha256: createHash('sha256').update(canonicalBytes).digest('hex'),
    canonicalBytes,
    canonicalByteLength: canonicalBytes.byteLength,
    wordCount,
    linePayloadBytes: Buffer.byteLength(
      JSON.stringify(record.line).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e'),
      'utf8'
    ),
    clock: [
      new Date(record.line.t).getHours(),
      new Date(record.line.t).getMinutes(),
      new Date(record.line.t).getSeconds()
    ]
      .map((part) => String(part).padStart(2, '0'))
      .join(':')
  }
}

function fixture(
  options: {
    initial?: IncrementalJournalSnapshot
    limits?: SpeechProvenanceLimits & { maxJournalBytes: number }
    current?: () => boolean
    canonical?: () => Promise<CanonicalIncrementalRecord>
    structuralResult?: boolean
    lookup?: IncrementalMeetingJournalStorage['lookupIdentity']
    commit?: IncrementalMeetingJournalStorage['commitAppend']
  } = {}
) {
  let currentSnapshot = options.initial ?? snapshot()
  let commitCalls = 0
  const storage: IncrementalMeetingJournalStorage = {
    readSnapshot: async () => ({ status: 'ok', snapshot: currentSnapshot }),
    lookupIdentity: options.lookup ?? (async () => ({ status: 'absent' })),
    commitAppend:
      options.commit ??
      (async (request) => {
        commitCalls++
        currentSnapshot = {
          ...currentSnapshot,
          acceptedRevision: request.nextRevision,
          durableRevision: request.nextRevision,
          recordCount: request.recordCount,
          wordCount: request.wordCount,
          linePayloadBytes: request.linePayloadBytes,
          storedBytes: currentSnapshot.storedBytes + request.canonicalByteLength
        }
        return { status: 'committed', snapshot: currentSnapshot }
      })
  }
  const isCurrent = options.current ?? (() => true)
  return {
    appender: createIncrementalMeetingAppender({
      meetingId,
      readLimits: () => options.limits ?? limits,
      isCurrent,
      canonicalizeRecord: async (_recordJson, binding) => {
        const value = await (options.canonical ?? (async () => canonical()))()
        if (options.structuralResult) return value as unknown as IncrementalRecordReceipt
        const receipt = issueIncrementalRecordReceipt(value, { ...binding, isCurrent })
        if (!receipt) throw new Error('test worker canonicalization should produce a valid receipt')
        return receipt
      },
      storage
    }),
    storage,
    readSnapshot: () => currentSnapshot,
    commitCalls: () => commitCalls
  }
}

describe('bounded incremental meeting append journal', () => {
  it('does not issue a receipt for schema-valid canonical data over the worker field budget', () => {
    const candidate = canonical('x'.repeat(limits.maxFieldBytes + 1))
    const binding = {
      ownerToken: Object.freeze(Object.create(null) as object),
      meetingId,
      limits: provenanceLimits,
      maxCanonicalBytes: limits.maxJournalBytes,
      isCurrent: () => true
    }
    expect(issueIncrementalRecordReceipt(candidate, binding)).toBeNull()

    const validReceipt = issueIncrementalRecordReceipt(canonical('within field limit'), binding)
    expect(validReceipt).not.toBeNull()
    discardIncrementalRecordReceipt(validReceipt ?? undefined)
  })

  it('computes the exact v1 payload overhead from record count and canonical line bytes', () => {
    const one = provenancePayloadBytes(1, 100)
    const two = provenancePayloadBytes(2, 200)
    expect(one).toBe(
      Buffer.byteLength('{"version":1,"clocks":["12:34:56"],"lines":[') +
        100 +
        Buffer.byteLength('],"transcriptSha256":"' + '0'.repeat(64) + '"}')
    )
    expect(two).toBe(one + 100 + Buffer.byteLength(',"12:34:56"') + Buffer.byteLength(','))
  })

  it('commits one record and advances only a matching durable frontier', async () => {
    const { appender, readSnapshot, commitCalls } = fixture()
    await expect(appender.append(recordJson, 0)).resolves.toEqual({ status: 'durable', revision: 1, duplicate: false })
    expect(readSnapshot()).toMatchObject({ acceptedRevision: 1, durableRevision: 1, recordCount: 1, wordCount: 0 })
    expect(commitCalls()).toBe(1)
  })

  it('captures appender callbacks and storage method identities at construction', async () => {
    let currentSnapshot = snapshot()
    let commits = 0
    const storage: IncrementalMeetingJournalStorage = {
      readSnapshot: async () => ({ status: 'ok', snapshot: currentSnapshot }),
      lookupIdentity: async () => ({ status: 'absent' }),
      commitAppend: async (request) => {
        commits++
        currentSnapshot = {
          ...currentSnapshot,
          acceptedRevision: request.nextRevision,
          durableRevision: request.nextRevision,
          recordCount: request.recordCount,
          wordCount: request.wordCount,
          linePayloadBytes: request.linePayloadBytes,
          storedBytes: currentSnapshot.storedBytes + request.canonicalByteLength
        }
        return { status: 'committed', snapshot: currentSnapshot }
      }
    }
    const options = {
      meetingId,
      readLimits: () => limits,
      isCurrent: () => true,
      canonicalizeRecord: async (_bytes: Uint8Array, binding: Parameters<typeof issueIncrementalRecordReceipt>[1]) => {
        const receipt = issueIncrementalRecordReceipt(canonical(), binding)
        if (!receipt) throw new Error('test worker canonicalization should produce a valid receipt')
        return receipt
      },
      storage
    }
    const appender = createIncrementalMeetingAppender(options)
    options.isCurrent = () => false
    options.canonicalizeRecord = async () => {
      throw new Error('replaced callback must not run')
    }
    storage.commitAppend = async () => ({ status: 'unavailable' })
    await expect(appender.append(recordJson, 0)).resolves.toEqual({
      status: 'durable',
      revision: 1,
      duplicate: false
    })
    expect(commits).toBe(1)
  })

  it('refuses a structurally copied worker record before storage commit', async () => {
    const copied = fixture({ structuralResult: true })
    await expect(copied.appender.append(recordJson, 0)).resolves.toEqual({
      status: 'refused',
      reason: 'INVALID_RECORD'
    })
    expect(copied.commitCalls()).toBe(0)
  })

  it('treats an exact identity-and-digest retry as idempotent and refuses conflicting bytes', async () => {
    const existing = { status: 'found' as const, sha256: canonical().sha256, revision: 1 }
    const exact = fixture({
      initial: snapshot({
        acceptedRevision: 1,
        durableRevision: 1,
        recordCount: 1,
        wordCount: 0,
        linePayloadBytes: canonical().linePayloadBytes,
        storedBytes: 3
      }),
      lookup: async () => existing
    })
    await expect(exact.appender.append(recordJson, 0)).resolves.toEqual({
      status: 'durable',
      revision: 1,
      duplicate: true
    })
    expect(exact.commitCalls()).toBe(0)

    const conflict = fixture({
      initial: snapshot({
        acceptedRevision: 1,
        durableRevision: 1,
        recordCount: 1,
        wordCount: 0,
        linePayloadBytes: canonical().linePayloadBytes,
        storedBytes: 3
      }),
      lookup: async () => ({ ...existing, sha256: 'b'.repeat(64) })
    })
    await expect(conflict.appender.append(recordJson, 0)).resolves.toEqual({
      status: 'refused',
      reason: 'CONFLICTING_IDENTITY'
    })
    expect(conflict.commitCalls()).toBe(0)
  })

  it('enforces revision, record, word, provenance-payload and journal-byte limits before commit', async () => {
    const stale = fixture({ initial: snapshot({ acceptedRevision: 2, durableRevision: 2 }) })
    await expect(stale.appender.append(recordJson, 1)).resolves.toEqual({ status: 'refused', reason: 'STALE_REVISION' })

    const count = fixture({
      initial: snapshot({
        acceptedRevision: limits.maxRecords,
        durableRevision: limits.maxRecords,
        recordCount: limits.maxRecords,
        wordCount: 0,
        linePayloadBytes: limits.maxRecords * canonical().linePayloadBytes,
        storedBytes: limits.maxRecords * canonical().canonicalByteLength
      })
    })
    await expect(count.appender.append(recordJson, limits.maxRecords)).resolves.toEqual({
      status: 'refused',
      reason: 'LIMIT'
    })

    const words = fixture({
      canonical: async () => canonical('word', 1),
      initial: snapshot({
        acceptedRevision: 1,
        durableRevision: 1,
        recordCount: 1,
        wordCount: limits.maxWords,
        linePayloadBytes: canonical().linePayloadBytes,
        storedBytes: canonical().canonicalByteLength
      })
    })
    await expect(words.appender.append(recordJson, 1)).resolves.toEqual({ status: 'refused', reason: 'LIMIT' })

    const payloadRecord = canonical()
    const nextPayloadBytes = provenancePayloadBytes(2, 2 * payloadRecord.linePayloadBytes)
    const payloadLimits = { ...limits, maxPayloadBytes: nextPayloadBytes - 1 }
    expect(provenancePayloadBytes(1, payloadRecord.linePayloadBytes)).toBeLessThanOrEqual(payloadLimits.maxPayloadBytes)
    expect(nextPayloadBytes).toBe(payloadLimits.maxPayloadBytes + 1)
    const oneRecordSnapshot = snapshot({
      acceptedRevision: 1,
      durableRevision: 1,
      recordCount: 1,
      wordCount: 0,
      linePayloadBytes: payloadRecord.linePayloadBytes,
      storedBytes: payloadRecord.canonicalByteLength
    })
    const payload = fixture({ limits: payloadLimits, initial: oneRecordSnapshot })
    await expect(payload.appender.append(recordJson, 1)).resolves.toEqual({ status: 'refused', reason: 'LIMIT' })

    expect(nextPayloadBytes).toBeLessThanOrEqual(250)
    const underBudget = fixture({ limits: { ...limits, maxPayloadBytes: 250 }, initial: oneRecordSnapshot })
    await expect(underBudget.appender.append(recordJson, 1)).resolves.toEqual({
      status: 'durable',
      revision: 2,
      duplicate: false
    })
    expect(underBudget.commitCalls()).toBe(1)
    expect(underBudget.readSnapshot()).toEqual(
      snapshot({
        acceptedRevision: 2,
        durableRevision: 2,
        recordCount: 2,
        wordCount: 0,
        linePayloadBytes: 2 * payloadRecord.linePayloadBytes,
        storedBytes: 2 * payloadRecord.canonicalByteLength
      })
    )

    const disk = fixture({
      initial: snapshot({
        acceptedRevision: 1,
        durableRevision: 1,
        recordCount: 1,
        wordCount: 0,
        linePayloadBytes: canonical().linePayloadBytes,
        storedBytes: limits.maxJournalBytes - canonical().canonicalByteLength + 1
      })
    })
    await expect(disk.appender.append(recordJson, 1)).resolves.toEqual({ status: 'refused', reason: 'LIMIT' })
    for (const result of [count, words, payload, disk]) expect(result.commitCalls()).toBe(0)
  })

  it('rechecks owner after canonicalization and identity lookup before an irreversible commit', async () => {
    let current = true
    const guarded = fixture({
      current: () => current,
      lookup: async () => {
        current = false
        return { status: 'absent' }
      }
    })
    await expect(guarded.appender.append(recordJson, 0)).resolves.toEqual({
      status: 'refused',
      reason: 'STALE_OWNER'
    })
    expect(guarded.commitCalls()).toBe(0)
  })

  it('uses the storage mutation fence when ownership retires during commit', async () => {
    let current = true
    const retired = fixture({
      current: () => current,
      commit: async (_request, isCurrent) => {
        current = false
        expect(isCurrent()).toBe(false)
        return { status: 'stale-owner' }
      }
    })
    await expect(retired.appender.append(recordJson, 0)).resolves.toEqual({
      status: 'refused',
      reason: 'STALE_OWNER'
    })
  })

  it('bounds work to one active operation instead of retaining an unbounded pending queue', async () => {
    let releaseLookup: (() => void) | undefined
    let markLookupStarted: (() => void) | undefined
    const lookupStarted = new Promise<void>((resolve) => (markLookupStarted = resolve))
    const held = fixture({
      lookup: () =>
        new Promise((resolve) => {
          markLookupStarted?.()
          releaseLookup = () => resolve({ status: 'absent' })
        })
    })
    const first = held.appender.append(recordJson, 0)
    await lookupStarted
    await expect(held.appender.append(recordJson, 0)).resolves.toEqual({ status: 'refused', reason: 'QUEUE_FULL' })
    releaseLookup?.()
    await expect(first).resolves.toMatchObject({ status: 'durable', revision: 1 })
  })
})
