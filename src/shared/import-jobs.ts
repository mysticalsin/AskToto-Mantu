import { z } from 'zod'

export type ImportJobState =
  | 'queued'
  | 'decoding'
  | 'transcribing'
  | 'saving'
  | 'recapping'
  | 'done'
  | 'failed'
  | 'policy-held'
  | 'cancelled'

/** Sanitised job state exposed to the overlay. Source paths remain main-process-only. */
export interface ImportJobView {
  jobId: string
  title: string
  state: ImportJobState
  cursor: number
  totalChunks: number
  /** Null means the decoder has not supplied a trustworthy denominator yet. */
  pct: number | null
  error?: string
  recapError?: string
  file?: string
  createdAt: number
  updatedAt: number
  queuePosition?: number
}

/** Main-owned, content-free view of recoverable jobs and policy-held checkpoint identities. */
export interface ImportJobsSnapshot {
  jobs: ImportJobView[]
  policyBlocked: boolean
  heldJobIds: string[]
  policyHeldJobIds: string[]
  inventoryOverflow: boolean
  policyHoldOverflow: boolean
}

export const ImportJobIdSchema = z.object({ jobId: z.string().min(1).max(200) })

/** Pushed while a session is transcribing/saving to drive the import progress label. */
export interface ImportAudioProgress {
  job: ImportJobView
}
