import { z } from 'zod'
import { CONTEXT_AUTHORITIES, CONTEXT_ORIGINS } from './context-authority'

/**
 * The per-turn context manifest and the user-triggered context contract (Métis 2.12 G46, CAP-10).
 *
 * A manifest names what an Ask or voice turn used: the records main put in front of the model, in order, with where
 * each came from and how big it was. It never holds the content itself, so showing it later ("what Métis used")
 * cannot leak what was read.
 *
 * `via` says why a record was there: `ask` is part of the ask itself (the typed or spoken question, the meeting
 * transcript tail, a screenshot the owner attached, a memory slice); `ambient` is the background screen reader's
 * cached description; `attachment` is a file or image the owner attached to this turn in the composer; `snapshot` is a screen or document capture the owner explicitly asked for; `grant` is a whole
 * document the owner granted for the session.
 */
export const CONTEXT_VIA = ['ask', 'ambient', 'snapshot', 'grant', 'attachment'] as const
export type ContextVia = (typeof CONTEXT_VIA)[number]

export const ContextManifestEntrySchema = z
  .object({
    origin: z.enum(CONTEXT_ORIGINS),
    authority: z.enum(CONTEXT_AUTHORITIES),
    sourceId: z.string().min(1).max(160),
    bytes: z.number().int().nonnegative(),
    via: z.enum(CONTEXT_VIA)
  })
  .strict()
export type ContextManifestEntry = z.infer<typeof ContextManifestEntrySchema>

export const ContextManifestSchema = z
  .object({
    turnId: z.string().min(1).max(200),
    createdAt: z.number().int().nonnegative(),
    entries: z.array(ContextManifestEntrySchema).max(32)
  })
  .strict()
export type ContextManifest = z.infer<typeof ContextManifestSchema>

/**
 * The gestures that may start a snapshot. Each is the owner explicitly asking about the screen or a document; there is
 * no ambient, background, hover or timer gesture, and none can be added from the renderer.
 */
export const SNAPSHOT_GESTURES = ['typed-screen-intent', 'hold-to-talk-screen-intent', 'capture-button'] as const
export type SnapshotGesture = (typeof SNAPSHOT_GESTURES)[number]

export const SnapshotKindSchema = z.enum(['screen', 'document'])
export type SnapshotKind = z.infer<typeof SnapshotKindSchema>

export const CONTEXT_IPC = {
  turnManifest: 'context:turnManifest',
  snapshotRequest: 'context:snapshotRequest',
  snapshotDelete: 'context:snapshotDelete',
  grantDocument: 'context:grantDocument',
  revokeGrant: 'context:revokeGrant',
  held: 'context:held'
} as const

const IdSchema = z.string().min(1).max(64)

export const TurnManifestRequestSchema = z.object({ turnId: z.string().min(1).max(200) }).strict()
export const SnapshotRequestSchema = z
  .object({ gesture: z.enum(SNAPSHOT_GESTURES), kind: SnapshotKindSchema.default('screen') })
  .strict()
export const SnapshotDeleteSchema = z.object({ snapshotId: IdSchema }).strict()
export const GrantDocumentSchema = z.object({ snapshotId: IdSchema, gesture: z.enum(SNAPSHOT_GESTURES) }).strict()
export const RevokeGrantSchema = z.object({ grantId: IdSchema }).strict()

/** Renderer-safe view of a held snapshot: what it is of and when it ends, never its text. */
export const HeldSnapshotSchema = z
  .object({
    snapshotId: IdSchema,
    kind: SnapshotKindSchema,
    sourceId: z.string().max(160),
    app: z.string().max(120).nullable(),
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    granted: z.boolean(),
    bytes: z.number().int().nonnegative()
  })
  .strict()
export type HeldSnapshot = z.infer<typeof HeldSnapshotSchema>

export const HeldContextSchema = z
  .object({
    snapshots: z.array(HeldSnapshotSchema).max(16),
    grants: z.array(z.object({ grantId: IdSchema, snapshotId: IdSchema, expiresAt: z.number().int() }).strict()).max(16)
  })
  .strict()
export type HeldContext = z.infer<typeof HeldContextSchema>

/** A content-free refusal code; the renderer shows its own copy. */
export const ContextRefusalSchema = z.enum([
  'signed-out',
  'private-view',
  'locked',
  'no-text',
  'stale',
  'limit',
  'not-found',
  'capture-failed',
  'invalid'
])
export type ContextRefusal = z.infer<typeof ContextRefusalSchema>

export type SnapshotResult = { ok: true; snapshot: HeldSnapshot } | { ok: false; reason: ContextRefusal }
export type GrantResult = { ok: true; grantId: string; expiresAt: number } | { ok: false; reason: ContextRefusal }
export type SimpleResult = { ok: true } | { ok: false; reason: ContextRefusal }
