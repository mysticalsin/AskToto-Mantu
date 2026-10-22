/**
 * The dictation memory contract shared by main, the preload bridge and the renderer (G26).
 *
 * Two things live behind it, both private to this profile and both encrypted at rest in main:
 *  - the dictation segment journal: what was recognized and not yet verified into a field, offered back to the person
 *    exactly once after an interruption. A recovered draft is shown, never inserted;
 *  - the personal dictionary: term to preferred spelling, learned only from text the person dictated and then
 *    corrected inside Métis.
 *
 * Channels live here, not in ipc.ts, so this feature adds no lines to that ratcheted file. Every channel is
 * renderer to main and sits behind the sender-auth gate. Main owns the text: the renderer can name a draft or a span
 * by an opaque id and send the corrected text; it can never supply the "original" a correction is learned from.
 */
import { z } from 'zod'

export const DICTATION_MEMORY_IPC = {
  /** The recoverable drafts, offered once. Taking them is the offer: they are never returned a second time. */
  recoveryTake: 'dictationMemory:recoveryTake',
  /** The person copied or dismissed a recovered draft (optionally after correcting it): the entry is retired. */
  recoveryResolve: 'dictationMemory:recoveryResolve',
  /** The dictated spans still inside the correction window (ids and text, newest first). */
  spansRecent: 'dictationMemory:spansRecent',
  /** The person corrected one of those spans inside Métis. */
  spansCorrect: 'dictationMemory:spansCorrect',
  dictionaryList: 'dictationMemory:dictionaryList',
  dictionaryRemove: 'dictationMemory:dictionaryRemove',
  dictionaryClear: 'dictationMemory:dictionaryClear'
} as const

/** PROPOSED: the longest corrected text main accepts (the dictation guard itself caps a draft at 32 KiB). */
export const DICTATION_CORRECTED_TEXT_MAX_CHARS = 16_000

/** PROPOSED: the longest dictated text carried to the UI (one journal entry holds at most 256 KiB). */
export const DICTATION_RECOVERY_TEXT_MAX_CHARS = 262_144

/** Opaque ids: 32 hex characters, minted in main. */
export const DictationMemoryIdSchema = z.string().regex(/^[0-9a-f]{32}$/)

export const DICTATION_RECOVERY_REASONS = ['interrupted', 'not_inserted'] as const
export type DictationRecoveryReason = (typeof DICTATION_RECOVERY_REASONS)[number]

/**
 * One draft the person can get back. `interrupted`: Métis closed or crashed while it was being dictated or inserted.
 * `not_inserted`: the dictation ended without a verified insertion and the draft was kept.
 */
export const DictationRecoveryItemSchema = z
  .object({
    id: DictationMemoryIdSchema,
    text: z.string().min(1).max(DICTATION_RECOVERY_TEXT_MAX_CHARS),
    savedAtMs: z.number().int().nonnegative(),
    reason: z.enum(DICTATION_RECOVERY_REASONS)
  })
  .strict()
export type DictationRecoveryItem = z.infer<typeof DictationRecoveryItemSchema>

/**
 * The typed recovery notice for the UI. `autoInsert` is the literal `false`: a recovered draft is never inserted by
 * Métis, only shown to the person, who copies it or dismisses it.
 */
export const DictationRecoveryNoticeSchema = z
  .object({
    v: z.literal(1),
    kind: z.literal('dictation-recovery'),
    autoInsert: z.literal(false),
    items: z.array(DictationRecoveryItemSchema).min(1).max(64)
  })
  .strict()
export type DictationRecoveryNotice = z.infer<typeof DictationRecoveryNoticeSchema>

export const DictationRecoveryResolveSchema = z
  .object({
    id: DictationMemoryIdSchema,
    /** The draft as the person left it after editing. Learning from it needs the original, which main holds. */
    correctedText: z.string().min(1).max(DICTATION_CORRECTED_TEXT_MAX_CHARS).optional()
  })
  .strict()
export type DictationRecoveryResolve = z.infer<typeof DictationRecoveryResolveSchema>

export const DictationSpanCorrectSchema = z
  .object({
    id: DictationMemoryIdSchema,
    correctedText: z.string().min(1).max(DICTATION_CORRECTED_TEXT_MAX_CHARS)
  })
  .strict()
export type DictationSpanCorrect = z.infer<typeof DictationSpanCorrectSchema>

export const DictationSpanSchema = z
  .object({
    id: DictationMemoryIdSchema,
    text: z.string().min(1).max(DICTATION_RECOVERY_TEXT_MAX_CHARS),
    insertedAtMs: z.number().int().nonnegative(),
    /** When the correction window closes (epoch ms). */
    expiresAtMs: z.number().int().nonnegative()
  })
  .strict()
export type DictationSpan = z.infer<typeof DictationSpanSchema>

export const DictationSpansSchema = z.object({ spans: z.array(DictationSpanSchema).max(32) }).strict()
export type DictationSpans = z.infer<typeof DictationSpansSchema>

export const DictionaryEntrySchema = z
  .object({
    id: DictationMemoryIdSchema,
    /** What the recognizer produced (lower-cased, trimmed). */
    heard: z.string().min(1).max(128),
    /** What the person wants written instead. */
    preferred: z.string().min(1).max(128),
    /** How many times the person made this correction. */
    count: z.number().int().positive(),
    updatedAtMs: z.number().int().nonnegative()
  })
  .strict()
export type DictionaryEntry = z.infer<typeof DictionaryEntrySchema>

export const DICTIONARY_STATUSES = ['ok', 'unavailable'] as const
export const DictionaryListSchema = z
  .object({
    status: z.enum(DICTIONARY_STATUSES),
    entries: z.array(DictionaryEntrySchema).max(2_000)
  })
  .strict()
export type DictionaryList = z.infer<typeof DictionaryListSchema>

export const DictionaryRemoveSchema = z.object({ id: DictationMemoryIdSchema }).strict()
export type DictionaryRemove = z.infer<typeof DictionaryRemoveSchema>

/** Content-free replies: a count or a status, never why a write was refused. */
export const DictationMemoryAckSchema = z.object({ ok: z.boolean(), count: z.number().int().nonnegative() }).strict()
export type DictationMemoryAck = z.infer<typeof DictationMemoryAckSchema>
