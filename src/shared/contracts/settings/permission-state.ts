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
