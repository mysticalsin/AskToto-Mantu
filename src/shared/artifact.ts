import { z } from 'zod'

/**
 * The artifact contract (Métis 2.12 G53, CAP-28). An artifact is a real file a turn produced. Main holds the record,
 * including the file path; the renderer only ever sees ids, names, sizes and a verified status, and asks main to open,
 * reveal or drag a file by `artifactId`. An answer may say "I made a file" only for an artifact whose record exists AND
 * whose file still exists with the recorded SHA-256.
 */
export const ARTIFACT_KINDS = ['document', 'image', 'audio', 'data', 'archive', 'other'] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

export const ARTIFACT_PRODUCERS = ['model', 'tool', 'user-import'] as const
export type ArtifactProducer = (typeof ARTIFACT_PRODUCERS)[number]

export const ArtifactProvenanceSchema = z
  .object({
    producer: z.enum(ARTIFACT_PRODUCERS),
    /** Ids of what the file was made from (a context-manifest sourceId, a tool call id, an import id). Never content. */
    sourceIds: z.array(z.string().min(1).max(160)).max(16)
  })
  .strict()
export type ArtifactProvenance = z.infer<typeof ArtifactProvenanceSchema>

/** The main-only record. `path` never crosses IPC. */
export const ArtifactRecordSchema = z
  .object({
    artifactId: z.string().min(1).max(64),
    turnId: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200),
    kind: z.enum(ARTIFACT_KINDS),
    displayName: z.string().min(1).max(120),
    path: z.string().min(1).max(4096),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    createdAt: z.number().int().nonnegative(),
    provenance: ArtifactProvenanceSchema
  })
  .strict()
export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>

/** `ready`: the file exists with the recorded digest. `missing`/`changed`: shown honestly, no actions offered. */
export const ARTIFACT_STATUSES = ['ready', 'missing', 'changed'] as const
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number]

/** What the renderer may see of an artifact. */
export const ArtifactChipSchema = z
  .object({
    artifactId: z.string().min(1).max(64),
    turnId: z.string().min(1).max(200),
    kind: z.enum(ARTIFACT_KINDS),
    displayName: z.string().min(1).max(120),
    bytes: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    producer: z.enum(ARTIFACT_PRODUCERS),
    status: z.enum(ARTIFACT_STATUSES)
  })
  .strict()
export type ArtifactChip = z.infer<typeof ArtifactChipSchema>

/** The sibling of the G46 context manifest: the files a turn produced, by id only. */
export const OutputManifestSchema = z
  .object({ turnId: z.string().min(1).max(200), artifactIds: z.array(z.string().min(1).max(64)).max(32) })
  .strict()
export type OutputManifest = z.infer<typeof OutputManifestSchema>

export interface TurnArtifacts {
  manifest: OutputManifest
  chips: ArtifactChip[]
}

export const ARTIFACT_IPC = {
  forTurn: 'artifacts:forTurn',
  open: 'artifacts:open',
  reveal: 'artifacts:reveal',
  arm: 'artifacts:arm',
  preview: 'artifacts:preview',
  copy: 'artifacts:copy',
  dragStart: 'artifacts:dragStart'
} as const

export const ArtifactTurnRequestSchema = z.object({ turnId: z.string().min(1).max(200) }).strict()
export const ArtifactIdRequestSchema = z.object({ artifactId: z.string().min(1).max(64) }).strict()

export type ArtifactActionResult =
  | { ok: true }
  | {
      ok: false
      reason:
        | 'signed-out'
        | 'invalid'
        | 'not-found'
        | 'missing'
        | 'changed'
        | 'blocked'
        | 'failed'
        | 'unsupported'
        | 'too-large'
    }

/** The one honest line for a file that is gone or different from what was recorded. */
export const ARTIFACT_CHANGED_NOTICE = 'This file was moved or changed'

/**
 * G55: previews are rendered by main into one self-contained document and shown in a window with no preload, no node,
 * no scripts and this policy. Nothing may load, connect, frame, submit or navigate; only inline styling and `data:`
 * images (the image preview itself) are allowed.
 */
export const ARTIFACT_PREVIEW_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

export const PREVIEW_TEXT_EXTENSIONS = ['.md', '.txt', '.csv', '.json', '.html'] as const
export const PREVIEW_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'] as const
export const PREVIEW_TEXT_MAX_BYTES = 1024 * 1024
export const PREVIEW_IMAGE_MAX_BYTES = 8 * 1024 * 1024

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot).toLowerCase()
}

/** How a file is previewed and copied. SVG, PDF and anything script-capable or unknown has no preview (open it instead). */
export function artifactContentType(name: string): 'text' | 'image' | null {
  const ext = extensionOf(name)
  if ((PREVIEW_TEXT_EXTENSIONS as readonly string[]).includes(ext)) return 'text'
  if ((PREVIEW_IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return 'image'
  return null
}

/** Fixed, content-free copy for each way an artifact action can fail. */
export const ARTIFACT_NOTICES = {
  unsupported: 'This file type can only be opened, not previewed or copied',
  tooLarge: 'This file is too large to preview or copy',
  failed: 'That did not work. Try Open instead',
  copied: 'Copied'
} as const

export function artifactFailureNotice(result: ArtifactActionResult): string | null {
  if (result.ok) return null
  if (result.reason === 'unsupported') return ARTIFACT_NOTICES.unsupported
  if (result.reason === 'too-large') return ARTIFACT_NOTICES.tooLarge
  if (result.reason === 'failed' || result.reason === 'blocked') return ARTIFACT_NOTICES.failed
  return ARTIFACT_CHANGED_NOTICE
}
