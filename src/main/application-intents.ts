import { z } from 'zod'
import type { ApplicationKind, ApplicationView, CandidateSetVersion } from './application-catalog-view'

/** Only ordinary JSON records cross this boundary. Inspect descriptors before Zod
 * reads values, so inherited fields and accessors never become typed intent data.
 */
const JsonRecordSchema = z.custom<Record<string, unknown>>((value: unknown) => {
  try {
    if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) return false
    return Reflect.ownKeys(value).every(key => {
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return descriptor !== undefined && descriptor.enumerable === true && 'value' in descriptor
    })
  } catch { return false }
}, 'Expected an ordinary JSON record')

// Match the existing catalog's public HMAC identity and candidate-set formats.
const ApplicationIdSchema = z.string().regex(/^app_[a-f0-9]{64}$/) satisfies z.ZodType<ApplicationView['id']>
export const CandidateSetVersionSchema = JsonRecordSchema.pipe(z.object({
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  digest: z.string().regex(/^[a-f0-9]{64}$/)
}).strict()).readonly() satisfies z.ZodType<CandidateSetVersion, z.ZodTypeDef, unknown>

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
export const ApplicationIntentSchema = JsonRecordSchema.pipe(z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('apps.list'), query: DisplayNameQuerySchema.optional() }).strict(),
  z.object({ operation: z.literal('apps.open'), ...target }).strict(),
  z.object({ operation: z.literal('apps.focus'), ...target }).strict(),
  z.object({ operation: z.literal('apps.quit'), ...target, mode: z.literal('graceful') }).strict()
])).readonly()

export type ApplicationIntent = z.infer<typeof ApplicationIntentSchema>
export type ApplicationListIntent = Extract<ApplicationIntent, { operation: 'apps.list' }>
export type ApplicationOpenIntent = Extract<ApplicationIntent, { operation: 'apps.open' }>
export type ApplicationFocusIntent = Extract<ApplicationIntent, { operation: 'apps.focus' }>
export type ApplicationQuitIntent = Extract<ApplicationIntent, { operation: 'apps.quit' }>

/** Untrusted input is deliberately separate from the inferred typed intent API. */
export function parseApplicationIntent(input: unknown) {
  return ApplicationIntentSchema.safeParse(input)
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
