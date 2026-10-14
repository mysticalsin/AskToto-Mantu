import { randomUUID } from 'node:crypto'
import { TextDecoder, TextEncoder } from 'node:util'
import { IncrementalMeetingRecordSchema } from '@shared/incremental-meeting'
import type { TranscriptLine } from '@shared/ipc'
import type {
  IncrementalMeetingJournalFileStorage,
  IncrementalJournalFileRecord,
  IncrementalJournalPageResult
} from './features/meetings/incremental-meeting-journal-files'
import type { IncrementalMeetingAppender } from './features/meetings/incremental-meeting-journal'
import {
  ImportCheckpointUnavailableError,
  type ImportCheckpoint,
  type ImportCheckpointFailure,
  type ImportCheckpointRepository,
  type ImportCheckpointResumeResult,
  type ImportHeaderPatch,
  type ImportJobHeader,
  type ImportPageRequest,
  type ImportPageResult,
  type ImportTranscriptHandle
} from './import-job-checkpoint-contract'
import type { ImportLegacyOriginHandle } from './import-legacy-origin'
import type { ImportPersistencePolicy } from './import-persistence-policy'
import {
  checkpointFromMetadata,
  decodeCheckpointMetadata,
  encodeCheckpointMetadata,
  matchesCheckpointSnapshot,
  safeComponent,
  boundedJsonBytes,
  validCounter,
  validateHeader,
  type CheckpointMetadata,
  type ImportJournalOwnerBinding,
  type ImportJournalSourceVersion,
  type PendingWindow
} from './import-journal-checkpoint-metadata'

const JOB_ID =
  /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|[0-9a-f]{32})$/
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/
const decoder = new TextDecoder('utf-8', { fatal: true })
const encoder = new TextEncoder()

/** A single root/key/writer-bound session. Implementations are composed from the root and key services. */
export interface ImportJournalSession {
  readonly jobId: string
  readonly meetingId: string
  readonly journalId: string
  readonly keyId: string
  readonly owner: ImportJournalOwnerBinding
  readonly source: ImportJournalSourceVersion
  readonly policy: ImportPersistencePolicy
  readonly storage: IncrementalMeetingJournalFileStorage
  readonly appender: IncrementalMeetingAppender
  assertCurrent(): void
  retire(): void
  settle(): Promise<void>
}

export interface ImportJournalCheckpointRuntime {
  /** Capture/open must enforce the exact original owner, root, source and legacy-origin attempt. */
  createNew(header: ImportJobHeader, origin: ImportLegacyOriginHandle, journalId: string): Promise<ImportJournalSession>
  openExisting(jobId: string, origin: ImportLegacyOriginHandle): Promise<ImportJournalSession>
  listHeldIds(): Promise<Readonly<{ jobIds: readonly string[]; overflow: boolean }>>
  assertOriginCurrent(origin: ImportLegacyOriginHandle): void
}

interface HandleState {
  readonly session: ImportJournalSession
  readonly origin: ImportLegacyOriginHandle
  metadata: CheckpointMetadata
  metadataRevision: number
  retired: boolean
  settled: boolean
}

const handleStates = new WeakMap<ImportTranscriptHandle, HandleState>()

function failure(error: unknown): ImportCheckpointFailure {
  if (error instanceof ImportCheckpointUnavailableError) return error.reason
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status?: unknown }).status
    if (status === 'stale-owner') return 'STALE_OWNER'
    if (status === 'limit') return 'RESOURCE_LIMIT'
    if (status === 'stale-revision') return 'CONFLICT'
    if (status === 'unavailable') return 'UNAVAILABLE'
  }
  return error instanceof Error ? 'UNAVAILABLE' : 'UNCONFIGURED'
}

function positiveLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function handleState(
  transcript: ImportTranscriptHandle,
  origin: ImportLegacyOriginHandle,
  runtime: ImportJournalCheckpointRuntime
): HandleState {
  const state = handleStates.get(transcript)
  if (!state || state.retired || state.settled || state.origin !== origin) {
    throw new ImportCheckpointUnavailableError('STALE_OWNER')
  }
  runtime.assertOriginCurrent(origin)
  state.session.assertCurrent()
  return state
}

async function commitMetadata(state: HandleState, expectedRevision: number, next: CheckpointMetadata): Promise<void> {
  const bytes = encodeCheckpointMetadata(next, state.session.policy.legacy.maxDescriptorBytes)
  if (!bytes) throw new ImportCheckpointUnavailableError('RESOURCE_LIMIT')
  try {
    state.session.assertCurrent()
    const result = await state.session.storage.commitApplicationMetadata(
      expectedRevision,
      bytes,
      state.session.policy.legacy.maxDescriptorBytes,
      () => {
        try {
          state.session.assertCurrent()
          return !state.retired && !state.settled
        } catch {
          return false
        }
      }
    )
    if (result.status !== 'ok') throw new ImportCheckpointUnavailableError(failure(result))
    try {
      state.session.assertCurrent()
    } finally {
      result.bytes?.fill(0)
    }
    state.metadata = next
    state.metadataRevision = result.revision
  } finally {
    bytes.fill(0)
  }
}

function assertMetadataFits(metadata: CheckpointMetadata, maxBytes: number): void {
  const bytes = encodeCheckpointMetadata(metadata, maxBytes)
  if (!bytes) throw new ImportCheckpointUnavailableError('RESOURCE_LIMIT')
  bytes.fill(0)
}

function safeRecordJson(line: TranscriptLine, recordId: string, policy: ImportPersistencePolicy): Uint8Array {
  if (!line || typeof line !== 'object' || Array.isArray(line) || Object.getPrototypeOf(line) !== Object.prototype) {
    throw new ImportCheckpointUnavailableError('MALFORMED')
  }
  const allowed = new Set(['speaker', 'text', 't', 'name', 'lang', 'provisional', 'speech'])
  const keys = Object.keys(line)
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(line, key)]))
  if (
    keys.length > 7 ||
    descriptors.has('speech') ||
    keys.some((key) => !allowed.has(key) || !descriptors.get(key) || !('value' in descriptors.get(key)!))
  ) {
    throw new ImportCheckpointUnavailableError('MALFORMED')
  }
  for (const field of ['text', 'name', 'lang'] as const) {
    const value = descriptors.get(field)?.value
    if (
      value !== undefined &&
      (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > policy.speech.maxFieldBytes)
    ) {
      throw new ImportCheckpointUnavailableError('RESOURCE_LIMIT')
    }
  }
  const candidate = {
    identity: { kind: 'local', recordId },
    source: 'local-final',
    line
  }
  if (!boundedJsonBytes(candidate, policy.speech.maxRecordBytes)) {
    throw new ImportCheckpointUnavailableError('RESOURCE_LIMIT')
  }
  const record = IncrementalMeetingRecordSchema.parse(candidate)
  const bytes = encoder.encode(JSON.stringify(record))
  if (bytes.byteLength > policy.speech.maxRecordBytes) {
    bytes.fill(0)
    throw new ImportCheckpointUnavailableError('RESOURCE_LIMIT')
  }
  return bytes
}

export function createImportJournalCheckpointRepository(
  runtime: ImportJournalCheckpointRuntime
): ImportCheckpointRepository {
  async function readMetadata(
    session: ImportJournalSession,
    jobId: string
  ): Promise<{
    metadata: CheckpointMetadata
    revision: number
  }> {
    session.assertCurrent()
    const result = await session.storage.readApplicationMetadata(() => {
      try {
        session.assertCurrent()
        return true
      } catch {
        return false
      }
    })
    session.assertCurrent()
    if (result.status !== 'ok' || !result.bytes) throw new ImportCheckpointUnavailableError(failure(result))
    try {
      const metadata = decodeCheckpointMetadata(result.bytes, {
        jobId,
        journalId: session.journalId,
        keyId: session.keyId,
        owner: session.owner,
        source: session.source,
        policy: session.policy
      })
      if (!metadata) throw new ImportCheckpointUnavailableError('MALFORMED')
      return { metadata, revision: result.revision }
    } finally {
      result.bytes.fill(0)
    }
  }

  async function openHandle(
    jobId: string,
    origin: ImportLegacyOriginHandle
  ): Promise<{
    status: 'ready' | 'retry'
    checkpoint: ImportCheckpoint
    state: HandleState
  }> {
    let session: ImportJournalSession | undefined
    try {
      session = await runtime.openExisting(jobId, origin)
      runtime.assertOriginCurrent(origin)
      session.assertCurrent()
      const initialized = await session.storage.initialize()
      session.assertCurrent()
      if (initialized.status !== 'ok') throw new ImportCheckpointUnavailableError(failure(initialized))
      const { metadata, revision } = await readMetadata(session, jobId)
      const snapshot = await session.storage.readSnapshot(session.meetingId, () => {
        try {
          session?.assertCurrent()
          return true
        } catch {
          return false
        }
      })
      session.assertCurrent()
      if (snapshot.status !== 'ok' || !matchesCheckpointSnapshot(metadata, snapshot.snapshot)) {
        throw new ImportCheckpointUnavailableError('CONFLICT')
      }
      const transcript = Object.freeze({}) as ImportTranscriptHandle
      const state: HandleState = {
        session,
        origin,
        metadata,
        metadataRevision: revision,
        retired: false,
        settled: false
      }
      handleStates.set(transcript, state)
      if (metadata.pending) {
        const pending = metadata.pending
        if (snapshot.snapshot.durableRevision === pending.baseRevision + 1 && pending.recordId) {
          let matchedRecord = false
          const page = await session.storage.readPage(
            pending.baseRevision,
            snapshot.snapshot.durableRevision,
            1,
            (record) => {
              session?.assertCurrent()
              if (
                record.revision !== pending.baseRevision + 1 ||
                record.canonicalBytes.byteLength > session!.policy.speech.maxRecordBytes
              )
                throw new ImportCheckpointUnavailableError('MALFORMED')
              let text: string
              let parsed: unknown
              try {
                text = decoder.decode(record.canonicalBytes)
                parsed = JSON.parse(text)
              } catch {
                throw new ImportCheckpointUnavailableError('MALFORMED')
              } finally {
                record.canonicalBytes.fill(0)
              }
              const result = IncrementalMeetingRecordSchema.safeParse(parsed)
              if (
                !result.success ||
                result.data.source !== 'local-final' ||
                result.data.identity.kind !== 'local' ||
                result.data.identity.recordId !== pending.recordId ||
                JSON.stringify(result.data) !== text
              )
                throw new ImportCheckpointUnavailableError('CONFLICT')
              matchedRecord = true
            },
            () => {
              try {
                runtime.assertOriginCurrent(origin)
                session?.assertCurrent()
                return true
              } catch {
                return false
              }
            },
            session.policy.journal.maxPageBytes
          )
          session.assertCurrent()
          if (
            page.status !== 'ok' ||
            !page.complete ||
            page.nextRevision !== snapshot.snapshot.durableRevision ||
            !matchedRecord
          ) {
            throw new ImportCheckpointUnavailableError('CONFLICT')
          }
          const next: CheckpointMetadata = {
            ...metadata,
            cursor: pending.nextCursor,
            totalChunks: pending.nextHeader.totalChunks,
            header: pending.nextHeader,
            frontier: {
              revision: snapshot.snapshot.durableRevision,
              recordCount: snapshot.snapshot.recordCount,
              wordCount: snapshot.snapshot.wordCount,
              payloadBytes: snapshot.snapshot.linePayloadBytes
            },
            pending: null
          }
          await commitMetadata(state, revision, next)
          return { status: 'ready', checkpoint: checkpointFromMetadata(next.header, next, transcript), state }
        }
        if (snapshot.snapshot.durableRevision !== pending.baseRevision) {
          throw new ImportCheckpointUnavailableError('CONFLICT')
        }
        const corePending = await session.storage.readPendingAppend(() => {
          try {
            runtime.assertOriginCurrent(origin)
            session?.assertCurrent()
            return true
          } catch {
            return false
          }
        })
        session.assertCurrent()
        if (corePending === 'pending') throw new ImportCheckpointUnavailableError('CONFLICT')
        if (corePending !== 'clear') throw new ImportCheckpointUnavailableError('UNAVAILABLE')
        const retry: CheckpointMetadata = { ...metadata, pending: null }
        assertMetadataFits(retry, session.policy.legacy.maxDescriptorBytes)
        await commitMetadata(state, revision, retry)
        return { status: 'retry', checkpoint: checkpointFromMetadata(retry.header, retry, transcript), state }
      }
      return { status: 'ready', checkpoint: checkpointFromMetadata(metadata.header, metadata, transcript), state }
    } catch (error) {
      session?.retire()
      if (session) await session.settle().catch(() => undefined)
      throw error
    }
  }

  return {
    async listHeldIds() {
      return runtime.listHeldIds()
    },

    async createNew(header, origin) {
      let session: ImportJournalSession | undefined
      try {
        if (!validateHeader(header, header.jobId) || !JOB_ID.test(header.jobId)) {
          return { status: 'held', reason: 'MALFORMED' }
        }
        runtime.assertOriginCurrent(origin)
        const journalId = randomUUID()
        session = await runtime.createNew(header, origin, journalId)
        runtime.assertOriginCurrent(origin)
        session.assertCurrent()
        if (
          session.jobId !== header.jobId ||
          session.journalId !== journalId ||
          session.meetingId !== journalId ||
          !UUID.test(session.meetingId) ||
          session.source.size !== header.sourceSizeBytes ||
          !safeComponent(session.owner.profileNamespace) ||
          !safeComponent(session.owner.principalAssociation) ||
          !safeComponent(session.owner.generation) ||
          !safeComponent(session.keyId)
        )
          throw new ImportCheckpointUnavailableError('OWNERSHIP_UNPROVEN')
        const initialized = await session.storage.initialize()
        session.assertCurrent()
        if (initialized.status !== 'ok') throw new ImportCheckpointUnavailableError(failure(initialized))
        const metadata: CheckpointMetadata = {
          version: 1,
          jobId: header.jobId,
          journalId,
          keyId: session.keyId,
          owner: session.owner,
          source: session.source,
          header: { ...header, cursor: 0, totalChunks: 0 },
          cursor: 0,
          totalChunks: 0,
          frontier: { revision: 0, recordCount: 0, wordCount: 0, payloadBytes: 0 },
          pending: null
        }
        const bytes = encodeCheckpointMetadata(metadata, session.policy.legacy.maxDescriptorBytes)
        if (!bytes) throw new ImportCheckpointUnavailableError('RESOURCE_LIMIT')
        try {
          const committed = await session.storage.commitApplicationMetadata(
            0,
            bytes,
            session.policy.legacy.maxDescriptorBytes,
            () => {
              try {
                runtime.assertOriginCurrent(origin)
                session?.assertCurrent()
                return Boolean(session)
              } catch {
                return false
              }
            }
          )
          session.assertCurrent()
          if (committed.status !== 'ok') throw new ImportCheckpointUnavailableError(failure(committed))
          committed.bytes?.fill(0)
        } finally {
          bytes.fill(0)
        }
        const transcript = Object.freeze({}) as ImportTranscriptHandle
        const state: HandleState = {
          session,
          origin,
          metadata,
          metadataRevision: 1,
          retired: false,
          settled: false
        }
        handleStates.set(transcript, state)
        return { status: 'ready', checkpoint: checkpointFromMetadata(metadata.header, metadata, transcript) }
      } catch (error) {
        session?.retire()
        if (session) await session.settle().catch(() => undefined)
        return { status: 'held', reason: failure(error) }
      }
    },

    async resume(jobId, origin) {
      if (!JOB_ID.test(jobId)) return { status: 'held', reason: 'MALFORMED' }
      try {
        const opened = await openHandle(jobId, origin)
        return { status: opened.status, checkpoint: opened.checkpoint }
      } catch (error) {
        return { status: 'held', reason: failure(error) }
      }
    },

    async appendWindow(checkpointValue, change, origin) {
      try {
        const state = handleState(checkpointValue.transcript, origin, runtime)
        const current = await readMetadata(state.session, state.metadata.jobId)
        if (
          current.revision !== state.metadataRevision ||
          current.metadata.cursor !== change.expectedCursor ||
          current.metadata.cursor !== state.metadata.cursor ||
          !validCounter(change.nextCursor) ||
          change.nextCursor !== change.expectedCursor + 1
        )
          throw new ImportCheckpointUnavailableError('CONFLICT')
        if (change.record === null) {
          if (current.metadata.pending !== null) throw new ImportCheckpointUnavailableError('CONFLICT')
          const snapshot = await state.session.storage.readSnapshot(state.session.meetingId, () => {
            try {
              state.session.assertCurrent()
              return true
            } catch {
              return false
            }
          })
          state.session.assertCurrent()
          if (snapshot.status !== 'ok' || !matchesCheckpointSnapshot(current.metadata, snapshot.snapshot)) {
            throw new ImportCheckpointUnavailableError('CONFLICT')
          }
          const totalChunks = Math.max(state.metadata.totalChunks, change.headerPatch.totalChunks)
          const nextHeader: ImportJobHeader = {
            ...state.metadata.header,
            ...change.headerPatch,
            cursor: change.nextCursor,
            totalChunks
          }
          if (
            !validateHeader(nextHeader, state.metadata.jobId) ||
            !boundedJsonBytes(nextHeader, state.session.policy.legacy.maxDescriptorBytes)
          )
            throw new ImportCheckpointUnavailableError('MALFORMED')
          const next: CheckpointMetadata = {
            ...state.metadata,
            cursor: change.nextCursor,
            totalChunks,
            header: nextHeader,
            pending: null
          }
          assertMetadataFits(next, state.session.policy.legacy.maxDescriptorBytes)
          await commitMetadata(state, current.revision, next)
          return { status: 'ready', checkpoint: checkpointFromMetadata(next.header, next, checkpointValue.transcript) }
        }
        const totalChunks = Math.max(state.metadata.totalChunks, change.headerPatch.totalChunks)
        const nextHeader: ImportJobHeader = {
          ...state.metadata.header,
          ...change.headerPatch,
          cursor: change.nextCursor,
          totalChunks
        }
        if (
          !validateHeader(nextHeader, state.metadata.jobId) ||
          !boundedJsonBytes(nextHeader, state.session.policy.legacy.maxDescriptorBytes)
        )
          throw new ImportCheckpointUnavailableError('MALFORMED')
        const pending: PendingWindow = {
          cursor: change.expectedCursor,
          nextCursor: change.nextCursor,
          baseRevision: state.metadata.frontier.revision,
          recordId: randomUUID(),
          nextHeader
        }
        let activePending = current.metadata.pending
        if (activePending) {
          if (
            activePending.cursor !== pending.cursor ||
            activePending.nextCursor !== pending.nextCursor ||
            activePending.baseRevision !== pending.baseRevision ||
            activePending.recordId === null ||
            JSON.stringify(activePending.nextHeader) !== JSON.stringify(nextHeader)
          )
            throw new ImportCheckpointUnavailableError('CONFLICT')
        } else {
          const reserved: CheckpointMetadata = { ...state.metadata, pending }
          assertMetadataFits(reserved, state.session.policy.legacy.maxDescriptorBytes)
          await commitMetadata(state, current.revision, reserved)
          activePending = pending
        }
        const recordBytes = safeRecordJson(change.record, activePending.recordId!, state.session.policy)
        let appendResult
        try {
          appendResult = await state.session.appender.append(recordBytes, activePending.baseRevision)
        } finally {
          recordBytes.fill(0)
        }
        state.session.assertCurrent()
        if (appendResult.status !== 'durable') {
          throw new ImportCheckpointUnavailableError(
            appendResult.reason === 'STALE_OWNER'
              ? 'STALE_OWNER'
              : appendResult.reason === 'LIMIT' || appendResult.reason === 'INVALID_RECORD'
                ? 'RESOURCE_LIMIT'
                : 'CONFLICT'
          )
        }
        const snapshot = await state.session.storage.readSnapshot(state.session.meetingId, () => {
          try {
            state.session.assertCurrent()
            return true
          } catch {
            return false
          }
        })
        state.session.assertCurrent()
        if (snapshot.status !== 'ok' || snapshot.snapshot.durableRevision !== appendResult.revision) {
          throw new ImportCheckpointUnavailableError('CONFLICT')
        }
        const next: CheckpointMetadata = {
          ...state.metadata,
          cursor: change.nextCursor,
          totalChunks,
          header: nextHeader,
          frontier: {
            revision: snapshot.snapshot.durableRevision,
            recordCount: snapshot.snapshot.recordCount,
            wordCount: snapshot.snapshot.wordCount,
            payloadBytes: snapshot.snapshot.linePayloadBytes
          },
          pending: null
        }
        await commitMetadata(state, state.metadataRevision, next)
        return { status: 'ready', checkpoint: checkpointFromMetadata(next.header, next, checkpointValue.transcript) }
      } catch (error) {
        return { status: 'held', reason: failure(error) }
      }
    },

    async saveHeader(checkpointValue, patch, origin) {
      try {
        const state = handleState(checkpointValue.transcript, origin, runtime)
        const current = await readMetadata(state.session, state.metadata.jobId)
        if (current.revision !== state.metadataRevision || current.metadata.cursor !== state.metadata.cursor) {
          throw new ImportCheckpointUnavailableError('CONFLICT')
        }
        const header: ImportJobHeader = { ...state.metadata.header, ...patch }
        header.cursor = state.metadata.cursor
        header.totalChunks = Math.max(state.metadata.totalChunks, patch.totalChunks ?? 0)
        if (!validateHeader(header, state.metadata.jobId)) throw new ImportCheckpointUnavailableError('MALFORMED')
        const next: CheckpointMetadata = {
          ...state.metadata,
          header,
          totalChunks: header.totalChunks
        }
        await commitMetadata(state, current.revision, next)
        return { status: 'ready', checkpoint: checkpointFromMetadata(header, next, checkpointValue.transcript) }
      } catch (error) {
        return { status: 'held', reason: failure(error) }
      }
    },

    async readPage(transcript, request, origin, sink) {
      const state = handleState(transcript, origin, runtime)
      const { session, metadata } = state
      if (metadata.pending !== null) throw new ImportCheckpointUnavailableError('CONFLICT')
      if (
        !validCounter(request.maxRecords) ||
        !positiveLimit(request.maxBytes) ||
        request.maxRecords > session.policy.journal.maxPageRecords ||
        request.maxBytes > session.policy.journal.maxPageBytes
      )
        throw new ImportCheckpointUnavailableError('RESOURCE_LIMIT')
      const afterRecordId = request.afterRecordId
      const afterRevision = afterRecordId === undefined ? 0 : Number(afterRecordId)
      if (
        !Number.isSafeInteger(afterRevision) ||
        afterRevision < 0 ||
        (afterRecordId !== undefined && !/^(?:0|[1-9]\d*)$/.test(afterRecordId))
      )
        throw new ImportCheckpointUnavailableError('MALFORMED')
      const expectedRevision = metadata.frontier.revision
      let records = 0
      let bytes = 0
      let nextRecordId: string | undefined
      const page: IncrementalJournalPageResult = await session.storage.readPage(
        afterRevision,
        expectedRevision,
        request.maxRecords,
        async (record: IncrementalJournalFileRecord) => {
          state.session.assertCurrent()
          const payloadLength = record.canonicalBytes.byteLength
          if (payloadLength <= 0 || payloadLength > request.maxBytes - bytes) {
            record.canonicalBytes.fill(0)
            throw new ImportCheckpointUnavailableError('RESOURCE_LIMIT')
          }
          let parsed: unknown
          try {
            parsed = JSON.parse(decoder.decode(record.canonicalBytes))
          } catch {
            record.canonicalBytes.fill(0)
            throw new ImportCheckpointUnavailableError('MALFORMED')
          }
          record.canonicalBytes.fill(0)
          const decoded = IncrementalMeetingRecordSchema.safeParse(parsed)
          if (!decoded.success || decoded.data.source !== 'local-final') {
            throw new ImportCheckpointUnavailableError('MALFORMED')
          }
          await sink.write(decoded.data.line)
          state.session.assertCurrent()
          records += 1
          bytes += payloadLength
          nextRecordId = String(record.revision)
        },
        () => {
          try {
            state.session.assertCurrent()
            runtime.assertOriginCurrent(origin)
            return true
          } catch {
            return false
          }
        },
        request.maxBytes
      )
      state.session.assertCurrent()
      if (page.status !== 'ok') throw new ImportCheckpointUnavailableError(failure(page))
      return {
        records,
        bytes,
        ...(nextRecordId ? { nextRecordId } : {}),
        complete: page.complete
      } satisfies ImportPageResult
    },

    retire(transcript) {
      const state = handleStates.get(transcript)
      if (!state || state.retired) return
      state.retired = true
      state.session.retire()
    },

    async settle(transcript) {
      const state = handleStates.get(transcript)
      if (!state || state.settled) return
      state.retired = true
      state.session.retire()
      await state.session.settle()
      state.settled = true
    }
  }
}
