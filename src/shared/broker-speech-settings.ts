import { z } from 'zod'
import { BROKERED_STT_PROVIDER_IDS, DIRECT_STT_PROVIDER_IDS } from './contracts/stt-provider'

/** Independent transport selector. Legacy settings keep using today's existing speech facade. */
export const BrokerSpeechSettingsSchema = z
  .object({
    transport: z.enum(['legacy', 'broker-v1']),
    engine: z.enum(['unconfigured', ...BROKERED_STT_PROVIDER_IDS])
  })
  .strict()
export type BrokerSpeechSettings = z.infer<typeof BrokerSpeechSettingsSchema>
export const BrokerSpeechSettingsWriteSchema = BrokerSpeechSettingsSchema

/** Explicit writes must be valid; load-time refusal and legacy omission are not writable profiles. */
export function assertBrokerSpeechSettingsPatch(patch: unknown): void {
  if (patch === null || typeof patch !== 'object' || !Object.hasOwn(patch, 'brokerSpeech')) return
  if (!BrokerSpeechSettingsWriteSchema.safeParse((patch as Record<string, unknown>).brokerSpeech).success)
    throw new Error('INVALID_PROFILE')
}

export const BrokerSpeechSettingsRefusalSchema = z
  .object({
    transport: z.literal('refused'),
    engine: z.literal('unconfigured'),
    reason: z.literal('INVALID_PROFILE')
  })
  .strict()
export type BrokerSpeechSettingsRefusal = z.infer<typeof BrokerSpeechSettingsRefusalSchema>
export type BrokerSpeechSettingsLoaded = BrokerSpeechSettings | BrokerSpeechSettingsRefusal

export const BROKER_SPEECH_SETTINGS_REFUSAL: BrokerSpeechSettingsRefusal = {
  transport: 'refused',
  engine: 'unconfigured',
  reason: 'INVALID_PROFILE'
}

export const DEFAULT_BROKER_SPEECH_SETTINGS: BrokerSpeechSettings = {
  transport: 'legacy',
  engine: 'unconfigured'
}

/** The load path stores only a valid profile or this fixed refusal; arbitrary malformed JSON is discarded. */
export const BrokerSpeechSettingsLoadSchema = z.preprocess(
  (value: unknown) => {
    if (value === undefined) return DEFAULT_BROKER_SPEECH_SETTINGS
    const parsed = BrokerSpeechSettingsSchema.safeParse(value)
    return parsed.success ? parsed.data : BROKER_SPEECH_SETTINGS_REFUSAL
  },
  z.union([BrokerSpeechSettingsSchema, BrokerSpeechSettingsRefusalSchema])
)

/** Existing speech settings grouped with the new selector so ipc.ts adds one schema spread, not line count. */
export const CloudSpeechSettingsSchema = z.object({
  /** Managed CLOUD_ONLY semantics remain independent of the broker transport selector. */
  enterpriseLive: z
    .object({
      managed: z.boolean().default(false),
      inferenceMode: z.enum(['legacy', 'cloud-only']).default('legacy'),
      summaryOnly: z.boolean().default(false)
    })
    .default({ managed: false, inferenceMode: 'legacy', summaryOnly: false }),
  /** Existing provider selection remains in place for legacy cloud speech. */
  cloudSttProvider: z.enum([...DIRECT_STT_PROVIDER_IDS, 'unconfigured']).default('unconfigured'),
  /** A finite load union preserves refusal without retaining arbitrary malformed user data. */
  brokerSpeech: BrokerSpeechSettingsLoadSchema
})

export type CloudSpeechSettings = z.infer<typeof CloudSpeechSettingsSchema>

export const DEFAULT_CLOUD_SPEECH_SETTINGS: CloudSpeechSettings = {
  enterpriseLive: { managed: false, inferenceMode: 'legacy', summaryOnly: false },
  cloudSttProvider: 'unconfigured',
  brokerSpeech: DEFAULT_BROKER_SPEECH_SETTINGS
}

export type BrokerSpeechSettingsResult =
  | { ok: true; value: BrokerSpeechSettings }
  | { ok: false; code: 'INVALID_PROFILE' }

/** Only an omitted legacy field defaults; any explicit malformed value is a refusal. */
export function parseBrokerSpeechSettings(value: unknown): BrokerSpeechSettingsResult {
  if (value === undefined) return { ok: true, value: DEFAULT_BROKER_SPEECH_SETTINGS }
  const parsed = BrokerSpeechSettingsSchema.safeParse(value)
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, code: 'INVALID_PROFILE' }
}
