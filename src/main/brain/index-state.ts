import { BRAIN_SCHEMA_VERSION, BrainIndexSchema, type BrainIndex, type IndexUnavailableCause } from '@shared/brain'
import { decodeSavedResult } from '../transcripts'

export const INDEX_REL = 'index.json'

export type IndexLoad =
  | { kind: 'ready'; index: BrainIndex }
  | { kind: 'absent' }
  | { kind: 'corrupt' }
  | { kind: 'unavailable'; cause: IndexUnavailableCause; detail?: string }

export type ResolvedIndex = Exclude<IndexLoad, { kind: 'corrupt' }>

export const BRAIN_INDEX_ERROR_CODE = {
  undecryptable: 'brain-index-undecryptable',
  io: 'brain-index-io',
  unsupportedVersion: 'brain-index-unsupported-version',
  corruptKept: 'brain-index-corrupt-kept',
  preserveFailed: 'brain-index-preserve-failed',
  changedDuringRebuild: 'brain-index-changed-during-rebuild',
  readableAgain: 'brain-index-readable-again',
  keystoreUnavailable: 'brain-index-keystore-unavailable'
} as const

export class BrainIndexUnavailableError extends Error {
  override readonly name = 'BrainIndexUnavailableError'
  constructor(readonly unavailable: IndexUnavailableCause) {
    super(`brain index is read-only on this device (${indexUnavailableCode(unavailable)})`)
  }
}

function indexUnavailableCode(cause: IndexUnavailableCause): string {
  switch (cause) {
    case 'unsupported':
      return BRAIN_INDEX_ERROR_CODE.unsupportedVersion
    case 'undecryptable':
      return BRAIN_INDEX_ERROR_CODE.undecryptable
    case 'corrupt-kept':
      return BRAIN_INDEX_ERROR_CODE.corruptKept
    case 'io':
      return BRAIN_INDEX_ERROR_CODE.io
    case 'cloud-only':
      return 'brain-index-cloud-only'
  }
}

export type BrainIndexRebuildErrorCode =
  | typeof BRAIN_INDEX_ERROR_CODE.preserveFailed
  | typeof BRAIN_INDEX_ERROR_CODE.changedDuringRebuild
  | typeof BRAIN_INDEX_ERROR_CODE.readableAgain
  | typeof BRAIN_INDEX_ERROR_CODE.keystoreUnavailable
  | typeof BRAIN_INDEX_ERROR_CODE.unsupportedVersion

export class BrainIndexRebuildError extends Error {
  override readonly name = 'BrainIndexRebuildError'
  constructor(readonly code: BrainIndexRebuildErrorCode) {
    super(code)
  }
}

/** Pure classification of index.json bytes. No filesystem writes. */
export function classifyIndexBytes(buf: Buffer): IndexLoad {
  if (buf.length === 0) return { kind: 'absent' }
  const decoded = decodeSavedResult(buf)
  if (!decoded.ok) return { kind: 'unavailable', cause: 'undecryptable', detail: decoded.reason }
  let raw: unknown
  try {
    raw = JSON.parse(decoded.text)
  } catch {
    return { kind: 'corrupt' }
  }
  const v = (raw as { schema_version?: unknown } | null)?.schema_version
  if (typeof v === 'number' && v > BRAIN_SCHEMA_VERSION) return { kind: 'unavailable', cause: 'unsupported' }
  const parsed = BrainIndexSchema.safeParse(raw)
  if (parsed.success) return { kind: 'ready', index: parsed.data }
  return { kind: 'corrupt' }
}
