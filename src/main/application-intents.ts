import { z } from 'zod'
import type { ApplicationKind, ApplicationView, CandidateSetVersion } from './application-catalog-view'

/** Zod itself probes then/catch before custom validators run. Screen and copy
 * descriptors outside every Zod entry point, including nested candidateSet data.
 * Null-prototype copies contain only primitive values and the one allowed record.
 */
function screenedRecord(value: unknown, nestedKey?: 'candidateSet'): Record<string, unknown> | null {
  try {
    if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) return null
    const copy: Record<string, unknown> = Object.create(null)
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) return null
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null
      const field: unknown = descriptor.value
      if (key === nestedKey) {
        const nested = screenedRecord(field)
        if (!nested) return null
        copy[key] = nested
      } else {
        if (field !== null && !['string', 'number', 'boolean', 'undefined'].includes(typeof field)) return null
        copy[key] = field
      }
    }
    return copy
  } catch { return null }
}

// Match the existing catalog's public HMAC identity and candidate-set formats.
const ApplicationIdSchema = z.string().regex(/^app_[a-f0-9]{64}$/) satisfies z.ZodType<ApplicationView['id']>
const CandidateSetVersionSchema = z.object({
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  digest: z.string().regex(/^[a-f0-9]{64}$/)
}).strict().readonly() satisfies z.ZodType<CandidateSetVersion>

const DisplayNameQuerySchema = z.string().min(1).max(120).refine(value =>
  value.trim().length > 0 &&
  !/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\\/:!]/u.test(value) &&
  !/\.(?:exe|app)\b/i.test(value) &&
  !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(value.trim()),
'Expected a display-name query, not a native target')

const target = { applicationId: ApplicationIdSchema, candidateSet: CandidateSetVersionSchema }

/** Parsing establishes shape only, never existence, freshness, identity or permission.
 * Future main-owned proposal/execution code must resolve and revalidate the catalog
 * binding and independently obtain any required confirmation.
 */
const ApplicationIntentSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('apps.list'), query: DisplayNameQuerySchema.optional() }).strict(),
  z.object({ operation: z.literal('apps.open'), ...target }).strict(),
  z.object({ operation: z.literal('apps.focus'), ...target }).strict(),
  z.object({ operation: z.literal('apps.quit'), ...target, mode: z.literal('graceful') }).strict()
]).readonly()

export type ApplicationIntent = z.infer<typeof ApplicationIntentSchema>
export type ApplicationListIntent = Extract<ApplicationIntent, { operation: 'apps.list' }>
export type ApplicationOpenIntent = Extract<ApplicationIntent, { operation: 'apps.open' }>
export type ApplicationFocusIntent = Extract<ApplicationIntent, { operation: 'apps.focus' }>
export type ApplicationQuitIntent = Extract<ApplicationIntent, { operation: 'apps.quit' }>

/** Untrusted input is deliberately separate from the inferred typed intent API. */
export function parseApplicationIntent(input: unknown): z.SafeParseReturnType<unknown, ApplicationIntent> {
  const screened = screenedRecord(input, 'candidateSet')
  if (!screened) return { success: false, error: new z.ZodError([
    { code: 'custom', path: [], message: 'Expected ordinary JSON intent data without accessors or native objects' }
  ]) }
  return ApplicationIntentSchema.safeParse(screened)
}

const capabilities = Object.freeze({
  'apps.list': Object.freeze({ operation: 'apps.list', risk: 'R0', stage: 'selection', executable: false } as const),
  'apps.open': Object.freeze({ operation: 'apps.open', risk: 'R1', stage: 'proposal', executable: false } as const),
  'apps.focus': Object.freeze({ operation: 'apps.focus', risk: 'R1', stage: 'proposal', executable: false } as const),
  'apps.quit': Object.freeze({ operation: 'apps.quit', risk: 'R2', stage: 'proposal', executable: false } as const)
})
export type ApplicationCapability = typeof capabilities[keyof typeof capabilities]
const eligibleKinds: readonly ApplicationKind[] = Object.freeze(['notes', 'browser', 'document-editor'])

/** Classification is descriptive, not authorization. Kind must come from the main
 * catalog, never an untrusted request; targeted proposals fail closed without it.
 */
export function classifyApplicationIntent(intent: ApplicationIntent, kind?: ApplicationKind): ApplicationCapability | null {
  const result = parseApplicationIntent(intent)
  if (!result.success || (kind !== undefined && !eligibleKinds.includes(kind))) return null
  if (result.data.operation !== 'apps.list' && kind === undefined) return null
  return capabilities[result.data.operation]
}
