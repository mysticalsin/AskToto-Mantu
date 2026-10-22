/**
 * The one speech-to-text provider list (Métis 2.12 G08, CAP-04).
 *
 * Every other provider or engine enum in the app derives from `STT_CLOUD_PROVIDER_IDS`: the brokered
 * engine ids, the legacy direct-token provider setting and the capability contract's speech engines.
 * A new cloud provider is added here once, and each consumer narrows the list to what it can serve.
 *
 * This module is a contract (zod only) so the capability contract, the speech contract and the settings
 * schema can all import it without a cycle or a layer breach.
 */
import { z } from 'zod'

/** Route A is Deepgram Nova-3 and Route B is Cloudflare Workers AI Nova-3; their ids stay distinct. */
export const STT_CLOUD_PROVIDER_IDS = ['deepgram-nova3', 'cloudflare-nova3', 'soniox'] as const
export type SttCloudProviderId = (typeof STT_CLOUD_PROVIDER_IDS)[number]

/** Providers the licensed speech broker serves with server-held credentials (transport `broker-v1`). */
export const BROKERED_STT_PROVIDER_IDS = [
  'deepgram-nova3',
  'cloudflare-nova3'
] as const satisfies readonly SttCloudProviderId[]

/** Providers the legacy path can open with a credential held on this device (transport `direct-token`). */
export const DIRECT_STT_PROVIDER_IDS = ['cloudflare-nova3', 'soniox'] as const satisfies readonly SttCloudProviderId[]

export const SttCloudProviderSchema = z.enum(STT_CLOUD_PROVIDER_IDS)

export const STT_TRANSPORTS = ['broker-v1', 'direct-token'] as const
export type SttTransport = (typeof STT_TRANSPORTS)[number]

/** Model ids by provider. Soniox publishes no model id in this app, so none is invented for it. */
const STT_MODEL_BY_PROVIDER: Record<SttCloudProviderId, string | null> = {
  'deepgram-nova3': 'nova-3',
  'cloudflare-nova3': '@cf/deepgram/nova-3',
  soniox: null
}

/**
 * Who a speech request actually runs as: provider, account, transport and model, resolved once per
 * request in main. The account is a non-secret label (a Cloudflare account id or a hashed seat), never
 * a token or key.
 */
export const SttResolvedIdentitySchema = z
  .object({
    provider: SttCloudProviderSchema,
    transport: z.enum(STT_TRANSPORTS),
    account: z.string().min(1).max(128).nullable(),
    model: z.string().min(1).max(64).nullable()
  })
  .strict()
export type SttResolvedIdentity = z.infer<typeof SttResolvedIdentitySchema>

export function sttResolvedIdentity(input: {
  provider: SttCloudProviderId
  transport: SttTransport
  account: string | null
}): SttResolvedIdentity {
  return {
    provider: input.provider,
    transport: input.transport,
    account: input.account,
    model: STT_MODEL_BY_PROVIDER[input.provider]
  }
}
