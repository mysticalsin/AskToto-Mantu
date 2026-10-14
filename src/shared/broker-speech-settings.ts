import { z } from 'zod'

/** Independent transport selector. Legacy settings keep using today's existing speech facade. */
export const BrokerSpeechSettingsSchema = z
  .object({
    transport: z.enum(['legacy', 'broker-v1']),
    engine: z.enum(['unconfigured', 'deepgram-nova3', 'cloudflare-nova3'])
  })
  .strict()
export type BrokerSpeechSettings = z.infer<typeof BrokerSpeechSettingsSchema>

export const DEFAULT_BROKER_SPEECH_SETTINGS: BrokerSpeechSettings = {
  transport: 'legacy',
  engine: 'unconfigured'
}

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
  cloudSttProvider: z.enum(['cloudflare-nova3', 'soniox', 'unconfigured']).default('unconfigured'),
  /** Keep malformed explicit values intact so the broker-specific strict parser can refuse them. */
  brokerSpeech: z.unknown().default(DEFAULT_BROKER_SPEECH_SETTINGS)
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
