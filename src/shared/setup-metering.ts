import { z } from 'zod'

/**
 * Setup metering (G56, CAP-13 "Setup is metered separately"). Work done to set Métis up (the onboarding role
 * interview, the assistants it creates) is recorded in the `setup` bucket only and never reaches a work meter.
 * Server-defined meters (G79/G80) classify an origin with `meterBucketFor` and count only `work`.
 */
export type MeterBucket = 'setup' | 'work'

export const SETUP_METER_KINDS = ['assistant-created', 'interview-completed'] as const
export type SetupMeterKind = (typeof SETUP_METER_KINDS)[number]

/** Origins that are setup by definition. Everything else is work. */
export const SETUP_ORIGINS = ['onboarding-interview', 'onboarding-replay'] as const
export type SetupOrigin = (typeof SETUP_ORIGINS)[number]

export function meterBucketFor(origin: string): MeterBucket {
  return (SETUP_ORIGINS as readonly string[]).includes(origin) ? 'setup' : 'work'
}

export const SETUP_METER_MAX_ENTRIES = 500

export const SetupMeterEntrySchema = z
  .object({
    key: z.string().regex(/^[0-9a-f]{64}$/),
    kind: z.enum(SETUP_METER_KINDS),
    at: z.number().int().nonnegative()
  })
  .strict()
export type SetupMeterEntry = z.infer<typeof SetupMeterEntrySchema>

/** What the renderer may read: counts and the moment normal allowance begins, never keys. */
export const SetupMeterSummarySchema = z
  .object({
    bucket: z.literal('setup'),
    assistantsCreated: z.number().int().nonnegative(),
    interviewsCompleted: z.number().int().nonnegative(),
    workAllowanceStartsAt: z.number().int().nonnegative().nullable()
  })
  .strict()
export type SetupMeterSummary = z.infer<typeof SetupMeterSummarySchema>
