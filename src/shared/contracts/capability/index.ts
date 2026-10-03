import { z } from 'zod'

/**
 * Capability contract (TASK-005, M2-0064): which engine is selected, allowed and ready, per capability.
 *
 * Speech (audio to text) and generation (text to text) are separate capabilities with separate engine
 * sets, so a provider that is ready to generate never makes speech look ready, and the reverse.
 *
 * The selected engine is reported as it is: when it is not ready, the capability is not ready. There is no
 * fallback field, cloud or local, so no consumer can switch engines behind the user's back; objects are
 * strict, so a `fallback` key added by a producer is rejected rather than silently dropped.
 */

/** Speech engines. `cloudflare-nova3` is the cloud engine reached through the Operator broker. */
export const SpeechEngineIdSchema = z.enum(['cloudflare-nova3', 'soniox', 'parakeet', 'whisper', 'apple'])
export type SpeechEngineId = z.infer<typeof SpeechEngineIdSchema>

/** A generation provider id, in the same form the signed model policy names providers. */
export const GenerationEngineIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
export type GenerationEngineId = z.infer<typeof GenerationEngineIdSchema>

/** Why an engine cannot serve its capability now. */
export const NotReadyReasonSchema = z.enum([
  'not-installed',
  'downloading',
  'not-configured',
  'unsupported-platform',
  'unreachable',
  'failed'
])
export type NotReadyReason = z.infer<typeof NotReadyReasonSchema>

/** Readiness of the selected engine: `ready`, or `not-ready` with its reason. */
export const EngineStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ready') }).strict(),
  z.object({ state: z.literal('not-ready'), reason: NotReadyReasonSchema }).strict()
])
export type EngineStatus = z.infer<typeof EngineStatusSchema>

function addIssue(context: z.RefinementCtx, message: string, path: Array<string | number>): void {
  context.addIssue({ code: z.ZodIssueCode.custom, message, path })
}

function reportDuplicates(context: z.RefinementCtx, field: string, engines: readonly string[]): void {
  engines.forEach((engine, index) => {
    if (engines.indexOf(engine) !== index) addIssue(context, `${engine} is listed twice.`, [field, index])
  })
}

/**
 * One capability's engines. Invariants: `allowed` and `ready` list each engine once, every ready engine is
 * allowed, the selected engine is allowed, and `status` is `ready` exactly when the selected engine is ready.
 */
function checkEngineSelection(
  selection: { selected: string; allowed: string[]; ready: string[]; status: EngineStatus },
  context: z.RefinementCtx
): void {
  const { selected, allowed, ready } = selection
  reportDuplicates(context, 'allowed', allowed)
  reportDuplicates(context, 'ready', ready)
  ready.forEach((candidate, index) => {
    if (!allowed.includes(candidate)) addIssue(context, `${candidate} is ready but not allowed.`, ['ready', index])
  })
  if (!allowed.includes(selected)) addIssue(context, `${selected} is selected but not allowed.`, ['selected'])
  if ((selection.status.state === 'ready') !== ready.includes(selected)) {
    addIssue(context, 'The status is ready exactly when the selected engine is ready.', ['status', 'state'])
  }
}

export const SpeechCapabilitySchema = z
  .object({
    capability: z.literal('speech'),
    selected: SpeechEngineIdSchema,
    allowed: z.array(SpeechEngineIdSchema).min(1),
    ready: z.array(SpeechEngineIdSchema),
    status: EngineStatusSchema
  })
  .strict()
  .superRefine(checkEngineSelection)
export type SpeechCapability = z.infer<typeof SpeechCapabilitySchema>

export const GenerationCapabilitySchema = z
  .object({
    capability: z.literal('generation'),
    selected: GenerationEngineIdSchema,
    allowed: z.array(GenerationEngineIdSchema).min(1),
    ready: z.array(GenerationEngineIdSchema),
    status: EngineStatusSchema
  })
  .strict()
  .superRefine(checkEngineSelection)
export type GenerationCapability = z.infer<typeof GenerationCapabilitySchema>

/** Both capabilities of this app, each in its own slot: one never stands in for the other. */
export const CapabilitiesSchema = z
  .object({ speech: SpeechCapabilitySchema, generation: GenerationCapabilitySchema })
  .strict()
export type Capabilities = z.infer<typeof CapabilitiesSchema>
