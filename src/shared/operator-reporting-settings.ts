/**
 * Main-authoritative settings for zero-config Operator reporting. Spread into BaseSettingsSchema so the
 * persisted shape lives beside the rest of the Operator contract without growing ipc.ts. The renderer can
 * never write any of these (stripped from settings patches in main, like operatorLicenseToken).
 */
import { z } from 'zod'
import { OPERATOR_LICENSE_MAX } from './operator-license'
import { defineSettingsFeature } from './settings-feature-module'

export const OperatorReportingSettingsShape = {
  /** Licence minted by auto-enrolment (SSO or embedded token). Encrypted at rest with the whole settings
   *  file. Never sent to the renderer. Deliberately NOT operatorLicenseToken, so gates see no credential. */
  operatorReportingToken: z.string().max(OPERATOR_LICENSE_MAX).default(''),
  operatorReportingJti: z.string().default(''),
  operatorReportingLast4: z.string().default(''),
  operatorReportingExpiresAt: z.number().nullable().default(null),
  /** Which credential is active: an admin licence or secret, or an auto-minted licence. null = none yet. */
  operatorLicenseOrigin: z.enum(['admin', 'sso', 'token']).nullable().default(null),
  /** Persisted enrolment state. `enrolling` and `disabled` are transient or policy-derived, never stored. */
  operatorEnrollState: z.enum(['unenrolled', 'enrolled', 'revoked']).default('unenrolled'),
  /** Epoch ms of the last enrolment check while `revoked` (daily re-check). 0 = never. */
  operatorEnrollCheckedAt: z.number().default(0)
}

export const OPERATOR_REPORTING_SETTINGS_DEFAULTS = {
  operatorReportingToken: '',
  operatorReportingJti: '',
  operatorReportingLast4: '',
  operatorReportingExpiresAt: null,
  operatorLicenseOrigin: null,
  operatorEnrollState: 'unenrolled' as const,
  operatorEnrollCheckedAt: 0
}

export const OPERATOR_REPORTING_FEATURE = defineSettingsFeature({
  id: 'operator-reporting',
  shape: OperatorReportingSettingsShape,
  mainOnlyKeys: Object.keys(OperatorReportingSettingsShape) as (keyof typeof OperatorReportingSettingsShape)[]
})

/** Keys only main may write. settingsSet strips them from renderer patches. */
export const OPERATOR_REPORTING_MAIN_KEYS: string[] = [...OPERATOR_REPORTING_FEATURE.mainOnlyKeys]
