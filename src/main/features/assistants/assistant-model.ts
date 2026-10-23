import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  ASSISTANT_INSTRUCTIONS_MAX_CHARS,
  ASSISTANT_NAME_MAX_CHARS,
  AssistantBaseSchema,
  AssistantPreviewItemSchema,
  type AssistantPreviewItem,
  type AssistantView
} from '@shared/assistants'
import { BUILTIN_MODE_LABELS, CONVERSATION_MODES } from '@shared/ipc'

const KEY = z.string().regex(/^[0-9a-f]{64}$/)

/**
 * One user assistant as stored (sealed) in the active memory partition. `ownerKey` and `tenantKey` are the Main-derived
 * HMACs the owner-session authority issues (never an email or a tenant id); `idempotencyKey` is the hash of the
 * proposal it was created from. None of the three ever leaves main.
 */
export const AssistantEntitySchema = z
  .object({
    assistantId: z.string().regex(/^a_[0-9a-f]{32}$/),
    ownerKey: KEY,
    tenantKey: KEY,
    name: z.string().min(1).max(ASSISTANT_NAME_MAX_CHARS),
    base: AssistantBaseSchema,
    instructions: z.string().max(ASSISTANT_INSTRUCTIONS_MAX_CHARS),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    revision: z.number().int().min(1).max(1_000_000),
    archived: z.boolean(),
    idempotencyKey: KEY
  })
  .strict()
export type AssistantEntity = z.infer<typeof AssistantEntitySchema>

/** The one-time record that history was mapped onto the system assistants (R049). Counts only. */
export const MigrationRecordSchema = z
  .object({
    version: z.literal(1),
    ranAt: z.number().int().nonnegative(),
    systemAssistants: z.number().int().nonnegative()
  })
  .strict()
export type MigrationRecord = z.infer<typeof MigrationRecordSchema>

export interface OwnerScope {
  ownerKey: string
  tenantKey: string
}

export interface CustomMode {
  id: string
  label: string
}

// Control characters other than tab and newline never belong in a name or in instructions.
const CONTROL = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g')

/** The canonical form of a draft: what the owner previews, what is hashed and what is stored. */
export function normalizeDraft(draft: { name: string; base: AssistantPreviewItem['base']; instructions?: string }): AssistantPreviewItem {
  const name = draft.name.normalize('NFC').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  const instructions = (draft.instructions ?? '').normalize('NFC').replace(/\r\n?/g, '\n').replace(CONTROL, '').trim()
  return { name, base: draft.base, instructions }
}

const sha256 = (parts: readonly unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex')

/** Hash of (tenant, owner, normalized draft): the same proposal by the same owner always has the same key. */
export function idempotencyKeyFor(scope: OwnerScope, draft: AssistantPreviewItem): string {
  return sha256(['metis.assistant.v1', scope.tenantKey, scope.ownerKey, draft.name, draft.base, draft.instructions])
}

export const assistantIdFor = (idempotencyKey: string): string => `a_${idempotencyKey.slice(0, 32)}`

/** What the renderer echoes on confirm to prove the preview it saw is the proposal that gets created. */
export function previewHashFor(items: readonly AssistantPreviewItem[]): string {
  return sha256(['metis.assistant.preview.v1', ...items.map((item) => [item.name, item.base, item.instructions])])
}

export function proposalIdFor(scope: OwnerScope, previewHash: string): string {
  return sha256(['metis.assistant.proposal.v1', scope.tenantKey, scope.ownerKey, previewHash]).slice(0, 32)
}

export function validPreviewItem(item: AssistantPreviewItem): boolean {
  return AssistantPreviewItemSchema.safeParse(item).success
}

export function viewOf(entity: AssistantEntity): AssistantView {
  return {
    assistantId: entity.assistantId,
    name: entity.name,
    base: entity.base,
    instructions: entity.instructions,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    revision: entity.revision,
    archived: entity.archived,
    system: false
  }
}

const MODE_ID = /^[A-Za-z0-9_-]{1,64}$/
const BUILTIN: ReadonlySet<string> = new Set(CONVERSATION_MODES)

const usableCustom = (custom: readonly CustomMode[]): CustomMode[] =>
  custom.filter((mode) => MODE_ID.test(mode.id) && !BUILTIN.has(mode.id) && mode.label.trim().length > 0)

/** The nine built-in modes, then the person's custom modes, as read-only assistants. Derived, never stored. */
export function systemAssistants(custom: readonly CustomMode[] = []): AssistantView[] {
  const system = (id: string, name: string): AssistantView => ({
    assistantId: `sys-${id}`,
    name: name.slice(0, ASSISTANT_NAME_MAX_CHARS),
    base: id,
    instructions: '',
    createdAt: 0,
    updatedAt: 0,
    revision: 1,
    archived: false,
    system: true
  })
  return [
    ...CONVERSATION_MODES.map((mode) => system(mode, BUILTIN_MODE_LABELS[mode])),
    ...usableCustom(custom).map((mode) => system(mode.id, mode.label.trim()))
  ]
}

export interface HistoryMapping {
  meetingId: string
  assistantId: string
  exact: boolean
}

/**
 * Old history maps one to one onto the system assistants by the mode each meeting was saved with. The meeting id is the
 * meeting's own (its file), copied through; a mode that no longer exists is shown under General, flagged inexact.
 * Nothing here reads or writes a meeting file.
 */
export function mapMeetingsToAssistants(
  meetings: ReadonlyArray<{ file: string; mode: string }>,
  custom: readonly CustomMode[] = []
): HistoryMapping[] {
  const known = new Set<string>([...CONVERSATION_MODES, ...usableCustom(custom).map((mode) => mode.id)])
  return meetings.map((meeting) =>
    known.has(meeting.mode)
      ? { meetingId: meeting.file, assistantId: `sys-${meeting.mode}`, exact: true }
      : { meetingId: meeting.file, assistantId: 'sys-general', exact: false }
  )
}
