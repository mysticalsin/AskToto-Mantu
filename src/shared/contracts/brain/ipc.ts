import { z } from 'zod'
import { EntityKindSchema } from './entity-kind'

export const SetDealOutcomePayloadSchema = z.object({
  dealSlug: z.string().min(1),
  outcome: z.enum(['open', 'won', 'lost'])
})

/** Every entity id/slug the correction payloads below carry is a canonical slug (store.ts's slugify()
 *  output: lowercase ascii, digits, and dashes only — see its own doc comment for the two fallback forms,
 *  `x-<hash>` and `<truncated>-<hash>`, both of which also match this charset). MI-2.5 Fix B, defense in
 *  depth: corrections.ts re-slugifies every id before it ever reaches a filesystem call regardless (a
 *  legit slug round-trips unchanged there), but rejecting a non-slug OUTRIGHT here — before the payload
 *  even reaches the handler — means a path-traversal string like '../../../etc/hosts' never gets this
 *  far at all, rather than silently collapsing to a slug that simply won't match anything. */
const SLUG_RE = /^[a-z0-9-]+$/

/** Payloads for the five correction-engine channels (Task MI-2) — see src/main/brain/corrections.ts
 *  for the mutations themselves. `kind`/`id`/`fromId`/`intoId` are entity slugs (immutable, the join
 *  key), never display names. `field`/`value` on brain:entityUpdateField are validated per (kind, field)
 *  inside corrections.ts, not here — the zod-valid set differs by kind (deal.velocity is an object,
 *  account.sector is an enum, everything else is a plain string) and is cheaper to check once, in one
 *  place, alongside the mutation itself. */
export const EntityRenamePayloadSchema = z.object({
  kind: EntityKindSchema,
  id: z.string().min(1).max(200).regex(SLUG_RE, 'Invalid entity id.'),
  newName: z.string().min(1).max(200),
  // Also append oldName -> newName to settings.asrCorrections (main-side composition, see index.ts) so
  // the live transcript stops mishearing the old name going forward.
  alsoFixAsr: z.boolean().optional()
})
export const EntityMergePayloadSchema = z.object({
  kind: EntityKindSchema,
  fromId: z.string().min(1).max(200).regex(SLUG_RE, 'Invalid entity id.'),
  intoId: z.string().min(1).max(200).regex(SLUG_RE, 'Invalid entity id.')
})
export const EntityUnmergePayloadSchema = z.object({
  targetSeq: z.number().int().nonnegative()
})
export const EntityUpdateFieldPayloadSchema = z.object({
  kind: EntityKindSchema,
  id: z.string().min(1).max(200).regex(SLUG_RE, 'Invalid entity id.'),
  field: z.string().min(1).max(60),
  value: z.unknown()
})
/** Payload for brain:field-decision (dashboard suggestion accept/dismiss, deferred CRM pattern 3) — the
 *  human reviews one provenance-bearing field (see ProvenantField/RENDERABLE_PROVENANCE_STATES in
 *  shared/brain.ts) and either accepts or dismisses the extraction. `field` is bounded the same way
 *  brain:entityUpdateField's is; the legal (kind, field) set is validated in corrections.ts, not here.
 *  `decision: 'dismiss'` is accepted by this schema but currently always refused by the handler — there
 *  is no correction-engine mutation that clears/reverts a field's value, only ones that pin a NEW one
 *  (see readFieldProvenance's doc comment in corrections.ts). */
export const FieldDecisionPayloadSchema = z.object({
  entityKind: EntityKindSchema,
  entityId: z.string().min(1).max(200).regex(SLUG_RE, 'Invalid entity id.'),
  field: z.string().min(1).max(60),
  decision: z.enum(['accept', 'dismiss'])
})

/** `dealSlug` is optional — a commitment spoken in a deal-less meeting (x.deal is null) lives ONLY on
 *  the named person's own ledger, so there's nothing to also flip on a deal. */
export const CommitmentRejectPayloadSchema = z.object({
  personSlug: z.string().min(1).max(200).regex(SLUG_RE, 'Invalid person id.'),
  dealSlug: z.string().max(200).regex(SLUG_RE, 'Invalid deal id.').optional(),
  text: z.string().min(1)
})

/** Payload for brain:meetingExtraction (Task MI-3) — `file` is a saved meeting's path or basename (only
 *  the basename is used, mirroring brainCommitmentSettle's convention); the handler slugifies it to the
 *  same key ingestExtraction wrote the extraction under (`.brain/meetings/<slugify(basename(file))>.json`). */
export const MeetingExtractionQuerySchema = z.object({ file: z.string().min(1) })

/** One needs-attention finding (Task MI-3, `brain:attention`) — surfaced in BrainView's Attention section
 *  with a jump action to the named entity's record page.
 *   - 'lint': a lintBrain contradiction (see lintBrainDetailed in main/brain/ingest.ts).
 *   - 'ambiguous': a provenant field whose confidence is 'AMBIGUOUS'.
 *   - 'contradicted_pin': a human-pinned/edited field whose superseded history records a value from a
 *     LATER meeting than the pin itself — recorded (never auto-resolved) per MI-1's supersession rule.
 *   - 'ingest_failed': a source file that durably failed extraction (idx.ingested[file].ok === false,
 *     see main/brain/attention.ts). Not entity-linked — `entityKind` is absent and `id` carries the
 *     source filename instead, so the renderer opens the transcript rather than a record page. */
export const AttentionItemSchema = z.object({
  kind: z.enum(['lint', 'ambiguous', 'contradicted_pin', 'ingest_failed']),
  entityKind: EntityKindSchema.optional(),
  id: z.string().min(1),
  label: z.string(),
  detail: z.string()
})
export type AttentionItem = z.infer<typeof AttentionItemSchema>
export const BrainAttentionResultSchema = z.object({ items: z.array(AttentionItemSchema) })
export type BrainAttentionResult = z.infer<typeof BrainAttentionResultSchema>

/** Result of brain:entityNames — canonical people/account names ONLY (never quotes, roles, deal data,
 *  or anything else from the entity files), for the ASR entity-casing bias feature. See
 *  lib/entity-casing.ts and the brainEntityNames handler in main/index.ts. */
export interface BrainEntityNamesResult {
  names: string[]
}

/** One settings.asrCorrections entry — the exact shape commitLine's consumer (lib/listen.ts
 *  correctionsRef) compiles into word-boundary regexes. Extracted from SettingsSchema (which arrays it,
 *  capped at 100) so a single pair can be validated on its own BEFORE it joins the array: store.ts's
 *  validKeysOnly drops the ENTIRE asrCorrections array when any one element fails validation, so a
 *  handler that blindly appends an oversized pair wouldn't just lose that pair — it would silently
 *  wipe every correction the user already had. */
export const AsrCorrectionPairSchema = z.object({ from: z.string().min(1).max(80), to: z.string().max(80) })

/** brain:entityRename's `alsoFixAsr` composition (reviewer IMPORTANT 3) — pure so both paths are unit-
 *  testable. Validates the pair per-element FIRST (see AsrCorrectionPairSchema above for why), dedupes,
 *  and enforces the array's own 100-entry cap, so the result can NEVER fail whole-array validation:
 *   - { kind: 'append', pairs } — hand `pairs` to setSettings as the new asrCorrections value
 *   - { kind: 'noop' }          — pair already present; write nothing
 *   - { kind: 'skipped', reason } — pair can't be represented (e.g. a name over the 80-char cap);
 *     the caller performs the rename anyway and surfaces the reason. */
export function appendAsrCorrection(
  existing: ReadonlyArray<{ from: string; to: string }>,
  from: string,
  to: string
): { kind: 'append'; pairs: Array<{ from: string; to: string }> } | { kind: 'noop' } | { kind: 'skipped'; reason: string } {
  const pair = { from, to }
  const parsed = AsrCorrectionPairSchema.safeParse(pair)
  if (!parsed.success) {
    return {
      kind: 'skipped',
      reason:
        'The name pair could not be added as a live-transcript ASR correction (names must be 1-80 characters). The rename itself was applied.'
    }
  }
  if (existing.some((c) => c.from === pair.from && c.to === pair.to)) return { kind: 'noop' }
  return { kind: 'append', pairs: [...existing, pair].slice(-100) }
}
