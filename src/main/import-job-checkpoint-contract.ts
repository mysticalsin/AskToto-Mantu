import type { TranscriptLine } from '@shared/ipc'
import type { ImportJob } from './import-job-types'
import type { ImportLegacyOriginHandle } from './import-legacy-origin'
import type { ImportPersistencePolicy } from './import-persistence-policy'

export type ImportJobHeader = Omit<ImportJob, 'lines'>

declare const transcriptHandleBrand: unique symbol
export type ImportTranscriptHandle = {
  readonly [transcriptHandleBrand]: true
}

export interface ImportCheckpoint {
  readonly header: Readonly<ImportJobHeader>
  readonly transcript: ImportTranscriptHandle
  readonly frontier: Readonly<{
    generation: string
    journalId: string
    revision: number
    recordCount: number
    wordCount: number
    payloadBytes: number
    cursor: number
  }>
}

export interface ImportProgressPatch {
  readonly cursor: number
  readonly totalChunks: number
  readonly progressPct?: number
  readonly durationMs?: number
  readonly updatedAt: number
}

export interface ImportHeaderPatch extends Partial<ImportProgressPatch> {
  readonly state?: ImportJobHeader['state']
  readonly title?: string
  readonly error?: string
  readonly recapError?: string
  readonly file?: string
  readonly mode?: string
  readonly chunkSec?: number
  readonly pipeline?: ImportJobHeader['pipeline']
}

export interface ImportPageRequest {
  readonly afterRecordId?: string
  readonly maxRecords: number
  readonly maxBytes: number
}

export interface ImportPageResult {
  readonly records: number
  readonly bytes: number
  readonly nextRecordId?: string
  readonly complete: boolean
}

export interface ImportBoundedRecordSink {
  write(record: TranscriptLine): Promise<void>
}

export type ImportCheckpointFailure =
  | 'UNCONFIGURED'
  | 'RESOURCE_LIMIT'
  | 'MALFORMED'
  | 'SOURCE_CHANGED'
  | 'OWNERSHIP_UNPROVEN'
  | 'KEY_UNAVAILABLE'
  | 'STALE_OWNER'
  | 'CONFLICT'

export type ImportCheckpointResumeResult =
  | { readonly status: 'ready'; readonly checkpoint: ImportCheckpoint }
  | { readonly status: 'held'; readonly reason: ImportCheckpointFailure }

export interface ImportCheckpointWindowChange {
  readonly expectedCursor: number
  readonly nextCursor: number
  readonly record: TranscriptLine | null
  readonly headerPatch: ImportProgressPatch
}

/** Runtime implementations must keep handles opaque and never return transcript-sized main-process arrays. */
export interface ImportCheckpointRepository {
  listHeldIds(): Promise<Readonly<{ jobIds: readonly string[]; overflow: boolean }>>
  resume(jobId: string, origin: ImportLegacyOriginHandle): Promise<ImportCheckpointResumeResult>
  appendWindow(
    checkpoint: ImportCheckpoint,
    change: ImportCheckpointWindowChange,
    origin: ImportLegacyOriginHandle
  ): Promise<ImportCheckpointResumeResult>
  saveHeader(
    checkpoint: ImportCheckpoint,
    patch: ImportHeaderPatch,
    origin: ImportLegacyOriginHandle
  ): Promise<ImportCheckpointResumeResult>
  readPage(
    transcript: ImportTranscriptHandle,
    request: ImportPageRequest,
    origin: ImportLegacyOriginHandle,
    sink: ImportBoundedRecordSink
  ): Promise<ImportPageResult>
  retire(transcript: ImportTranscriptHandle): void
  settle(transcript: ImportTranscriptHandle): Promise<void>
}

/** The only legacy reader admitted by this contract is an injected implementation with captured limits and origin. */
export interface ImportLegacyCheckpointDecoder {
  read(
    request: Readonly<{ jobId: string; policy: ImportPersistencePolicy; origin: ImportLegacyOriginHandle }>,
    assertCurrent: () => void
  ): Promise<ImportCheckpoint>
}

export class ImportCheckpointUnavailableError extends Error {
  constructor(readonly reason: ImportCheckpointFailure) {
    super(
      reason === 'UNCONFIGURED'
        ? 'Saved import recovery is not configured.'
        : reason === 'OWNERSHIP_UNPROVEN'
          ? 'This saved import cannot be associated with the current owner.'
          : reason === 'RESOURCE_LIMIT'
            ? 'This saved import exceeds the configured recovery limits.'
            : 'This saved import cannot be recovered safely.'
    )
    this.name = 'ImportCheckpointUnavailableError'
  }
}
