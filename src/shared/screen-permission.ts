/**
 * screen-permission.ts — shared shapes of the Screen Recording diagnosis and Repair (M2-0429).
 *
 * macOS pins the Screen Recording grant to one exact code identity, and every ad-hoc build has a new one, so
 * "System Settings shows it on" and "this build can capture" can disagree. The persisted PermissionState is
 * the history that lets src/main/capture-permissions/diagnose.ts tell that apart from a plain denial.
 */
import { z } from 'zod'

/** One build as macOS's permission database sees it: the app version plus its code-directory hash. An
 *  empty cdhash means "not known" (helper missing, or not macOS), never "unsigned". */
export const AppIdentitySchema = z.object({
  version: z.string().max(64),
  cdhash: z.string().max(128)
})
export type AppIdentity = z.infer<typeof AppIdentitySchema>

/** Main-owned (settings:set strips it from renderer patches). */
export const PermissionStateSchema = z.object({
  /** The build that last let a real capture attempt through to macOS (which is what raises its prompt).
   *  macOS asks only once per identity, so a later attempt by the same build can only fail silently. */
  screenAskedFor: AppIdentitySchema.nullable().default(null),
  /** The build that last completed a real screen capture: the one the system switch was proven to serve. */
  screenGrantedFor: AppIdentitySchema.nullable().default(null),
  /** When the user said "It's already on" in System Settings (ms, 0 = never). Still denied after the
   *  relaunch that follows means the switch belongs to another copy or build. */
  attestedOnAt: z.number().default(0),
  /** A Repair reset the entry and relaunched (ms, 0 = none pending). The next boot re-probes once. */
  repairStartedAt: z.number().default(0),
  /** The last Repair's tccutil call failed, so the copy guides the manual remove-then-add instead. */
  repairFailed: z.boolean().default(false)
})
export type PermissionState = z.infer<typeof PermissionStateSchema>
export const DEFAULT_PERMISSION_STATE: PermissionState = {
  screenAskedFor: null,
  screenGrantedFor: null,
  attestedOnAt: 0,
  repairStartedAt: 0,
  repairFailed: false
}

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
