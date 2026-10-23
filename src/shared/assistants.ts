/**
 * The assistant entity contract shared by main, the preload bridge and the renderer (Métis 2.12 G48, CAP-26).
 *
 * An assistant is a role the person owns: a name, a built-in mode as its base, and bounded instructions. User assistants
 * live encrypted in main under the active memory partition (the verified tenant plus the verified user) and can be read
 * by nobody else. The nine built-in modes (and the person's custom modes) are exposed as read-only system assistants, so
 * every existing meeting maps to one without its file or its id being touched.
 *
 * Channels live here, not in ipc.ts, so this feature adds no lines to that ratcheted file. Every channel is renderer to
 * main behind the sender-auth gate. The renderer never sees an owner key, a tenant key or an idempotency key, and never
 * supplies who is proposing: a proposal made through this surface is the owner's typed command, and anything derived from
 * content (a transcript, a screen, a document) is data that cannot propose.
 */
import { z } from 'zod'
import { CONVERSATION_MODES } from './ipc'

/** IPC methods with no input reject accidental or injected payloads instead of silently ignoring them. */
export const AssistantNoPayloadSchema = z.undefined()

export const ASSISTANT_IPC = {
  list: 'assistants:list',
  propose: 'assistants:propose',
  confirm: 'assistants:confirm',
  update: 'assistants:update',
  archive: 'assistants:archive',
  historyMap: 'assistants:historyMap'
} as const

/** PROPOSED bounds. */
export const ASSISTANT_NAME_MAX_CHARS = 60
export const ASSISTANT_INSTRUCTIONS_MAX_CHARS = 4_000
export const ASSISTANT_PROPOSAL_MAX_ITEMS = 5
export const ASSISTANT_PROPOSAL_TTL_MS = 10 * 60_000
export const ASSISTANT_LIMIT_PER_OWNER = 100

const REVISION = z.number().int().min(1).max(1_000_000)
const TIME = z.number().int().nonnegative()

/** A user assistant id (`a_` plus 32 hex, derived from its idempotency key) or a system assistant id (`sys-<mode>`). */
export const AssistantIdSchema = z.string().regex(/^(a_[0-9a-f]{32}|sys-[A-Za-z0-9_-]{1,64})$/)
export const ProposalIdSchema = z.string().regex(/^[0-9a-f]{32}$/)
export const PreviewHashSchema = z.string().regex(/^[0-9a-f]{64}$/)

export const AssistantBaseSchema = z.enum(CONVERSATION_MODES)

export const AssistantDraftSchema = z
  .object({
    name: z.string().trim().min(1).max(ASSISTANT_NAME_MAX_CHARS),
    base: AssistantBaseSchema,
    instructions: z.string().max(ASSISTANT_INSTRUCTIONS_MAX_CHARS).default('')
  })
  .strict()
export type AssistantDraft = z.infer<typeof AssistantDraftSchema>

/** A draft as main normalized it and the owner will see it in the preview (no defaults left to fill). */
export const AssistantPreviewItemSchema = z
  .object({
    name: z.string().min(1).max(ASSISTANT_NAME_MAX_CHARS),
    base: AssistantBaseSchema,
    instructions: z.string().max(ASSISTANT_INSTRUCTIONS_MAX_CHARS)
  })
  .strict()
export type AssistantPreviewItem = z.infer<typeof AssistantPreviewItemSchema>

export const ProposeRequestSchema = z
  .object({ drafts: z.array(AssistantDraftSchema).min(1).max(ASSISTANT_PROPOSAL_MAX_ITEMS) })
  .strict()
export const ConfirmRequestSchema = z.object({ proposalId: ProposalIdSchema, previewHash: PreviewHashSchema }).strict()
export const UpdateRequestSchema = z
  .object({
    assistantId: AssistantIdSchema,
    expectedRevision: REVISION,
    name: AssistantDraftSchema.shape.name.optional(),
    base: AssistantBaseSchema.optional(),
    instructions: z.string().max(ASSISTANT_INSTRUCTIONS_MAX_CHARS).optional()
  })
  .strict()
  .refine((value) => value.name !== undefined || value.base !== undefined || value.instructions !== undefined)
export const ArchiveRequestSchema = z
  .object({ assistantId: AssistantIdSchema, expectedRevision: REVISION, archived: z.boolean() })
  .strict()

/** What the renderer may see of an assistant. No owner key, tenant key or idempotency key. */
export const AssistantViewSchema = z
  .object({
    assistantId: AssistantIdSchema,
    name: z.string().min(1).max(ASSISTANT_NAME_MAX_CHARS),
    /** A built-in mode id, or a custom mode id for a system assistant. */
    base: z.string().min(1).max(64),
    instructions: z.string().max(ASSISTANT_INSTRUCTIONS_MAX_CHARS),
    createdAt: TIME,
    updatedAt: TIME,
    revision: REVISION,
    archived: z.boolean(),
    /** A built-in or custom mode exposed as an assistant: read-only. */
    system: z.boolean()
  })
  .strict()
export type AssistantView = z.infer<typeof AssistantViewSchema>

export const LIST_REASONS = ['signed-out', 'invalid', 'unavailable'] as const
export const ListResultSchema = z.union([
  z.object({ ok: z.literal(true), assistants: z.array(AssistantViewSchema).max(400) }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(LIST_REASONS) }).strict()
])
export type ListResult = z.infer<typeof ListResultSchema>

export const PROPOSE_REFUSALS = ['signed-out', 'invalid', 'not-owner-command', 'limit', 'unavailable'] as const
export const ProposeResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      proposalId: ProposalIdSchema,
      /** The renderer echoes this on confirm: it proves the exact preview below is what is created. */
      previewHash: PreviewHashSchema,
      expiresAt: TIME,
      items: z.array(AssistantPreviewItemSchema).min(1).max(ASSISTANT_PROPOSAL_MAX_ITEMS)
    })
    .strict(),
  z.object({ ok: z.literal(false), reason: z.enum(PROPOSE_REFUSALS) }).strict()
])
export type ProposeResult = z.infer<typeof ProposeResultSchema>

export const CONFIRM_REFUSALS = [
  'signed-out',
  'invalid',
  'unknown-proposal',
  'expired',
  'preview-mismatch',
  'limit',
  'stale',
  'unavailable'
] as const
export const ConfirmResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      assistants: z.array(z.object({ assistant: AssistantViewSchema, created: z.boolean() }).strict()).max(5)
    })
    .strict(),
  z.object({ ok: z.literal(false), reason: z.enum(CONFIRM_REFUSALS) }).strict()
])
export type ConfirmResult = z.infer<typeof ConfirmResultSchema>

export const MUTATION_REFUSALS = [
  'signed-out',
  'invalid',
  'not-found',
  'read-only',
  'stale-revision',
  'archived',
  'stale',
  'unavailable'
] as const
export const MutationResultSchema = z.union([
  z.object({ ok: z.literal(true), assistant: AssistantViewSchema }).strict(),
  z
    .object({
      ok: z.literal(false),
      reason: z.enum(MUTATION_REFUSALS),
      /** On a stale revision: the current state, so the caller can retry from it. */
      current: AssistantViewSchema.optional()
    })
    .strict()
])
export type MutationResult = z.infer<typeof MutationResultSchema>

/** One meeting and the system assistant its history belongs to. `meetingId` is the meeting's own id, unchanged. */
export const HistoryMappingSchema = z
  .object({
    meetingId: z.string().min(1).max(512),
    assistantId: AssistantIdSchema,
    /** False when the meeting's mode is not a known mode and it is shown under the General assistant. */
    exact: z.boolean()
  })
  .strict()
export const HistoryMapResultSchema = z.union([
  z.object({ ok: z.literal(true), migrated: z.boolean(), mapping: z.array(HistoryMappingSchema) }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(LIST_REASONS) }).strict()
])
export type HistoryMapResult = z.infer<typeof HistoryMapResultSchema>
