import { z } from 'zod'

/**
 * Connector catalog (G60, CAP-30). One typed, versioned list of the operations Métis really performs against a
 * connected account. An entry exists only when main registers a handler for it (the contract test pins both
 * directions), so nothing here is advertised without being implemented.
 *
 * MCP connections (bidstack, clickup, plane) are not listed: their tools are declared by the remote server at
 * connect time and governed by G63/G64, so a static entry would be a guess. They keep their own path.
 */

/** Connector kinds that have fixed, built-in operations. */
export const CONNECTOR_KINDS = ['outlook'] as const
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number]

/** What an operation does to the account. Everything except `read` must pass the ActionGuard. */
export const CONNECTOR_EFFECTS = ['read', 'create', 'send', 'modify', 'delete'] as const
export type ConnectorEffect = (typeof CONNECTOR_EFFECTS)[number]

export function isWriteEffect(effect: ConnectorEffect): boolean {
  return effect !== 'read'
}

/** Main derives owner- and tenant-scoped opaque references; multiple refs may exist for one connector kind. */
export type AccountRef = string & { readonly __brand: 'ConnectorAccountRef' }

export interface ConnectorOperation {
  opId: string
  kind: ConnectorKind
  effect: ConnectorEffect
  /** One line for confirm cards and logs. */
  summary: string
  /** Provider scopes the account must hold for this call. */
  scopes: readonly string[]
  input: z.ZodType
  output: z.ZodType
}

const OutlookDraftInput = z.object({
  subject: z.string().max(200).default(''),
  body: z.string().max(20_000).default('')
})
const OutlookEventInput = z.object({
  subject: z.string().max(200).default(''),
  body: z.string().max(20_000).default(''),
  startIso: z.string().max(40).optional(),
  endIso: z.string().max(40).optional()
})
const CreatedId = z.object({ id: z.string().min(1) })
const CalendarTodayInput = z.object({ tz: z.string().max(64).default('UTC') })
const CalendarTodayOutput = z.object({ events: z.array(z.object({ subject: z.string() }).passthrough()) })

export const CONNECTOR_CATALOG: readonly ConnectorOperation[] = Object.freeze([
  {
    opId: 'outlook.calendar.today',
    kind: 'outlook',
    effect: 'read',
    summary: "Read today's calendar events",
    scopes: ['Calendars.Read'],
    input: CalendarTodayInput,
    output: CalendarTodayOutput
  },
  {
    opId: 'outlook.draft.create',
    kind: 'outlook',
    effect: 'create',
    summary: 'Create a mail draft (never sent)',
    scopes: ['Mail.ReadWrite'],
    input: OutlookDraftInput,
    output: CreatedId
  },
  {
    opId: 'outlook.event.create',
    kind: 'outlook',
    effect: 'create',
    summary: 'Create a calendar event with no attendees (no invitations)',
    scopes: ['Calendars.ReadWrite'],
    input: OutlookEventInput,
    output: CreatedId
  }
])

/**
 * Monotonic. Bump it whenever the catalog changes in any way a plan could depend on (an op added, removed, or its
 * effect, scopes or input shape changed). `CONNECTOR_CATALOG_DIGEST` is pinned by a test so a change without a
 * bump fails CI.
 */
export const CONNECTOR_CATALOG_REVISION = 1

/** Stable description of the parts of an operation a plan depends on. */
export function describeOperation(op: ConnectorOperation): string {
  const shape = (schema: z.ZodType): string =>
    schema instanceof z.ZodObject
      ? Object.keys(schema.shape as Record<string, unknown>)
          .sort()
          .join(',')
      : '*'
  return [op.opId, op.kind, op.effect, [...op.scopes].sort().join(','), shape(op.input), shape(op.output)].join('|')
}

export function catalogFingerprint(ops: readonly ConnectorOperation[]): string {
  return ops.map(describeOperation).sort().join('\n')
}

export type ConnectorRefusalReason =
  | 'op_unknown'
  | 'catalog_changed'
  | 'input_invalid'
  | 'account_unavailable'
  /** More than one account could run it and no trusted signal picked one (G62). Nothing ran. */
  | 'account_ambiguous'
  | 'account_not_ready'
  | 'grant_stale'
  | 'not_approved'
  | 'handler_failed'
  | 'output_invalid'

/**
 * Which rule chose the account (G62). A closed set of labels: never an email, a tenant id or an account ref, so it is
 * safe in audit metadata.
 */
export const ACCOUNT_RESOLUTION_RULES = [
  'explicit_owner_choice',
  'source_item_account',
  'only_account',
  'only_executable_account',
  'single_healthy_account'
] as const
export type AccountResolutionRule = (typeof ACCOUNT_RESOLUTION_RULES)[number]

/** Where a result came from. Carried on every successful and failed call. */
export interface ConnectorProvenance {
  connectorKind: ConnectorKind
  accountRef: AccountRef
  /** Which rule chose `accountRef`. */
  accountRule: AccountResolutionRule
  opId: string
  revision: number
}

/** The ActionGuard evidence for a write: bound to the exact arguments, observed from the handler. */
export interface ConnectorWriteReceipt {
  argsHash: string
  idempotencyKey: string
  observation: string
}

export interface ConnectorAccountChoiceOption {
  accountRef: AccountRef
  label: string
  maskedHint?: string
  health: 'connecting' | 'healthy' | 'degraded' | 'needs_reauth' | 'disconnected'
  /** Ready for this operation's effect right now (G61 readiness). Unready accounts are shown, never pickable. */
  selectable: boolean
  /** `sign_in`: connected, but not the identity the connector will actually use right now. */
  reason?: 'sign_in'
}

export type ConnectorResult =
  | { ok: true; output: unknown; provenance: ConnectorProvenance; receipt?: ConnectorWriteReceipt }
  | {
      ok: false
      reason: ConnectorRefusalReason
      message: string
      provenance?: ConnectorProvenance
      /** The provider reported a missing consent (maps to the existing "grant permission" UI). */
      needsConsent?: boolean
      error?: string
      /** With `account_ambiguous`: the accounts the owner can choose between (renderer-safe fields only). */
      choices?: ConnectorAccountChoiceOption[]
    }
