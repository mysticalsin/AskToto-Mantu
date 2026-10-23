/** G58: the shapes the export channels return. Receipts name where an export landed and prove what was
 *  written; they never carry meeting content. Re-exported from ./ipc. */
export type ExportKind = 'meeting-markdown' | 'recap-pdf' | 'diagnostics-bundle'
export type ExportConflictResolution = 'none' | 'keep-both' | 'replace'

export interface ExportReceipt {
  exportId: string
  kind: ExportKind
  /** Absolute path the file or folder was written to. */
  destination: string
  bytes: number
  /** SHA-256 (hex) of exactly the bytes written. A folder digests its sorted per-file digests. */
  sha256: string
  writtenAt: string
  conflictResolution: ExportConflictResolution
}

interface ExportChannelResult {
  ok: boolean
  /** Absolute path written (absent when the user cancelled). */
  path?: string
  cancelled?: boolean
  error?: string
  receipt?: ExportReceipt
}

/** recall:export-plain: a user-initiated decrypted markdown copy of ONE saved meeting. Never a bulk decrypt. */
export type RecallExportPlainResult = ExportChannelResult
/** recap:pdf */
export type RecapPdfResult = ExportChannelResult
/** diagnostics:export: `path` is the folder the bundle was written to. */
export interface DiagnosticsExportResult extends ExportChannelResult {
  /** How many files were copied. */
  files?: number
}
/** export:reveal */
export interface ExportRevealResult {
  ok: boolean
  error?: string
}
