/**
 * Métis member-pass + offline-first license compatibility exports.
 *
 * The IPC payload schemas live in contracts/license/schema.ts; this path remains for older imports.
 */

/** Selling switch. False in this change: Activate runs the real client path and
 *  returns ActivationUnavailable. Never silently no-op. Never pretend success. */
export const LICENSE_ACTIVATION_OPEN = false

export {
  DEFAULT_GRACE_DAYS,
  DEVICE_HASH_PREFIX,
  LICENSE_ISSUER,
  LICENSE_KID,
  LicenseClaimsSchema,
  MemberActivatePayloadSchema,
  V1ActivateErrSchema,
  V1ActivateOkSchema,
  V1ActivateRequestSchema,
  V1ActivateResponseSchema,
  V1RegisterErrSchema,
  V1RegisterOkSchema,
  V1RegisterRequestSchema,
  V1RegisterResponseSchema,
  emptyLicenseStatus,
  type IdentitySnapshot,
  type LicenseClaims,
  type LicenseEdition,
  type LicenseSource,
  type LicenseState,
  type MemberActivatePayload,
  type MemberActivateResult,
  type MemberLicenseError,
  type MemberLicenseStatus,
  type SerialKind,
  type V1ActivateRequest,
  type V1ActivateResponse,
  type V1RegisterRequest,
  type V1RegisterResponse
} from './contracts/license/schema'
