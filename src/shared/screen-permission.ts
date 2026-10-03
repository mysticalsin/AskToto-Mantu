/**
 * screen-permission.ts — shared shapes of the Screen Recording diagnosis and Repair (M2-0429).
 *
 * macOS pins the Screen Recording grant to one exact code identity, and every ad-hoc build has a new one, so
 * "System Settings shows it on" and "this build can capture" can disagree. The persisted PermissionState is
 * the history that lets src/main/capture-permissions/diagnose.ts tell that apart from a plain denial.
 */
import { z } from 'zod'
import type { AppIdentity } from './contracts/settings/permission-state'
export {
  AppIdentitySchema,
  DEFAULT_PERMISSION_STATE,
  PermissionStateSchema,
  type AppIdentity,
  type PermissionState
} from './contracts/settings/permission-state'

/**
 * What stands between this build and a working screen / meeting-audio capture. The raw macOS status cannot
 * say it: it reads 'denied' both for a never-asked app and for a grant that belongs to another copy or build
 * of Métis. See src/main/capture-permissions/diagnose.ts for how each state is reached.
 */
export type ScreenDiagnosisState = 'granted' | 'not-asked' | 'denied' | 'needs-relaunch' | 'not-effective' | 'restricted'
export type ScreenDiagnosisReason = 'identity-changed' | 'duplicate-bundles' | 'attested-then-relaunched' | 'translocated'
export type ScreenDiagnosisAction = 'none' | 'request' | 'open-settings' | 'relaunch' | 'repair' | 'move-to-applications'
/** Another installed app bundle that carries this app's bundle id. */
export interface AppBundleCopy {
  path: string
  version: string
}
export interface ScreenDiagnosis {
  state: ScreenDiagnosisState
  reasons: ScreenDiagnosisReason[]
  action: ScreenDiagnosisAction
  /** Other copies with this bundle id; macOS may resolve the Settings switch to any of them. */
  duplicates: AppBundleCopy[]
  /** The build last seen capturing, when it is not this one: the build the switch most likely serves. */
  grantedFor: AppIdentity | null
  /** The last Repair could not reset the entry; guide the manual remove-then-add instead. */
  repairFailed: boolean
}
/** This running build's code-signing identity, read by metis-mac-helper `code-identity`. */
export interface CodeIdentity {
  version: string
  cdhash: string
  teamId: string
  adhoc: boolean
}
export type PermissionStatus = 'granted' | 'denied' | 'unknown' | 'not-required'
export interface PlatformPermissions {
  microphone: PermissionStatus
  screenRecording: PermissionStatus
  /** M2-0429: the diagnosis behind screenRecording, and (macOS) this build's signing identity. */
  screenDiagnosis?: ScreenDiagnosis
  identity?: CodeIdentity | null
}

export const ScreenCaptureCheckPassSchema = z.enum(['probe', 'vision'])
export const ScreenCaptureCheckPayloadSchema = z.object({
  pass: ScreenCaptureCheckPassSchema
})
export const ScreenCaptureCheckResultSchema = z.object({
  ok: z.boolean(),
  pass: ScreenCaptureCheckPassSchema,
  backend: z.enum(['probe', 'local', 'api']).optional(),
  backendLabel: z.string().max(200).optional(),
  failedOver: z.boolean().optional(),
  message: z.string().max(2000),
  preview: z.string().max(200).optional()
})
export type ScreenCaptureCheckResult = z.infer<typeof ScreenCaptureCheckResultSchema>

/** permissions:repairScreen result. `guidance` is the manual fallback when the reset could not run. */
export type ScreenRepairResult =
  | { ok: true }
  | { ok: false; reason: 'unsupported-platform' | 'bundle-not-allowed' | 'tccutil-failed'; exitCode: number | null; guidance: string }
