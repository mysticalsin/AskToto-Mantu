/**
 * Update lifecycle (Métis 2.12 G86): the states an in-app update moves through and the words the UI needs.
 * Download and install are separate steps; an install never closes a meeting, a dictation, a voice
 * conversation or a running task. Pure types plus zod. The state carries versions and reason codes only,
 * never an account, a path, a team id or any task or meeting content.
 */
import { z } from 'zod'

export const UPDATE_LIFECYCLE_IPC = {
  /** renderer → main: the current lifecycle snapshot. */
  stateGet: 'update:state:get',
  /** main → main window: the snapshot after every transition. */
  state: 'update:state'
} as const

export const UPDATE_BUSY_REASONS = ['meeting', 'dictation', 'conversation', 'task', 'import'] as const
export type UpdateBusyReason = (typeof UPDATE_BUSY_REASONS)[number]

export const UPDATE_PHASES = [
  'idle',
  'checking',
  'available',
  'available-deferred',
  'downloading',
  'verifying',
  'ready',
  'verify-failed',
  'install-deferred',
  'installing',
  'install-failed',
  'post-verify',
  'current',
  'helpers-quarantined',
  'unknown-version',
  'error'
] as const
export type UpdatePhase = (typeof UPDATE_PHASES)[number]

export const HELPER_RESULTS = ['pass', 'integrity-only', 'fail', 'skipped', 'skipped-no-inventory'] as const
export interface HelperVerdict {
  /** A fixed label ('mac-helper', 'ffmpeg', 'managed-node', 'app', 'inventory'); never a path. */
  id: string
  result: (typeof HELPER_RESULTS)[number]
  /** A reason code such as 'codesign', 'team-mismatch', 'sha-mismatch'; never a path or an identity. */
  reason?: string
}

const VersionSchema = z.string().regex(/^\d+(?:\.\d+){1,3}$/)

export const HelperVerdictSchema = z
  .object({
    id: z.string().max(40),
    result: z.enum(HELPER_RESULTS),
    reason: z.string().max(60).optional()
  })
  .strict()

export const UpdateLifecycleStateSchema = z
  .object({
    phase: z.enum(UPDATE_PHASES),
    version: VersionSchema.optional(),
    fromVersion: VersionSchema.optional(),
    deferred: z.array(z.enum(UPDATE_BUSY_REASONS)).max(5).optional(),
    helpers: z.array(HelperVerdictSchema).max(8).optional(),
    rollbackUrl: z
      .string()
      .max(200)
      .regex(/^https:\/\/github\.com\/mysticalsin\/Metis-Releases\/releases\/tag\/v\d+(?:\.\d+){1,3}$/)
      .optional()
  })
  .strict()
export type UpdateLifecycleState = z.infer<typeof UpdateLifecycleStateSchema>

/** What Install and relaunch answers. `installed:true` means the relaunch has begun. */
export type UpdateInstallResult =
  | { installed: true }
  | { installed: false; deferred: UpdateBusyReason[] }
  | { installed: false; reason: 'not-ready' | 'receipt-failed' | 'install-failed' | 'not-signed-in' }

export const UPDATE_DEFERRED_COPY = 'Installs after your meeting or task ends. Nothing is closed now.'
export const UPDATE_QUARANTINE_COPY = 'Helper check failed after update'
