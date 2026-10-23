import { randomUUID } from 'node:crypto'
import { basename, extname, isAbsolute, normalize } from 'node:path'
import {
  ARTIFACT_KINDS,
  ArtifactProvenanceSchema,
  type ArtifactKind,
  type ArtifactProvenance,
  type ArtifactRecord,
  type OutputManifest
} from '@shared/artifact'
import type { ArtifactFs } from './artifact-fs'

/** Types an OS handler would execute or mount. Never recorded as artifacts, so never opened or dragged on a click. */
const EXECUTABLE_EXTENSIONS = new Set([
  '.app',
  '.command',
  '.exe',
  '.bat',
  '.cmd',
  '.com',
  '.scr',
  '.msi',
  '.ps1',
  '.vbs',
  '.jar',
  '.sh',
  '.lnk',
  '.dmg',
  '.pkg',
  '.terminal',
  '.workflow',
  '.action',
  '.pif',
  '.reg',
  '.js',
  '.jse',
  '.wsf',
  '.hta',
  '.url',
  '.webloc'
])

const KIND_BY_EXTENSION: Record<string, ArtifactKind> = {
  '.md': 'document',
  '.txt': 'document',
  '.pdf': 'document',
  '.docx': 'document',
  '.rtf': 'document',
  '.html': 'document',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.svg': 'image',
  '.mp3': 'audio',
  '.wav': 'audio',
  '.m4a': 'audio',
  '.csv': 'data',
  '.json': 'data',
  '.xlsx': 'data',
  '.tsv': 'data',
  '.zip': 'archive',
  '.tar': 'archive',
  '.gz': 'archive'
}

export interface ArtifactRegistryDeps {
  /** The owner in force (the memory partition id), or null when nobody is. A record is visible only to its owner. */
  owner(): string | null
  fs: ArtifactFs
  now(): number
  newId?(): string
  /** Records remembered per owner. Oldest are forgotten first. */
  limit?: number
}

export interface RegisterArtifactInput {
  turnId: string
  sessionId: string
  /** An absolute, normalized path of a file that already exists. Main-only. */
  path: string
  kind?: ArtifactKind
  displayName?: string
  provenance: ArtifactProvenance
}

export type RegisterArtifactResult =
  | { ok: true; record: ArtifactRecord }
  | { ok: false; reason: 'no-owner' | 'invalid' | 'invalid-path' | 'not-a-file' | 'blocked-type' | 'unreadable' }

export interface ArtifactRegistry {
  register(input: RegisterArtifactInput): Promise<RegisterArtifactResult>
  /** The record, only for the owner that registered it. A forged, unknown or foreign id is null. */
  get(artifactId: string): ArtifactRecord | null
  /** The turn-bound output manifest: ids only, in creation order. */
  outputManifest(turnId: string): OutputManifest
  clear(): void
}

/** A display name is a bare file name: no directories, no control characters, bounded. */
export function safeDisplayName(raw: string): string {
  const base = basename(raw.replace(/\\/g, '/'))
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return (clean || 'file').slice(0, 120)
}

export function artifactKindOf(path: string): ArtifactKind {
  return KIND_BY_EXTENSION[extname(path).toLowerCase()] ?? 'other'
}

export function isExecutableType(path: string): boolean {
  return EXECUTABLE_EXTENSIONS.has(extname(path).toLowerCase())
}

/**
 * The artifact records (G53): one per real file a turn produced, with its size and SHA-256 taken from the file itself at
 * registration. In memory, bounded, per owner. The path stays in main.
 */
export function createArtifactRegistry(deps: ArtifactRegistryDeps): ArtifactRegistry {
  const limit = deps.limit ?? 200
  const newId = deps.newId ?? (() => randomUUID())
  const records = new Map<string, { owner: string; record: ArtifactRecord }>()
  return {
    async register(input) {
      const owner = deps.owner()
      if (owner === null) return { ok: false, reason: 'no-owner' }
      const provenance = ArtifactProvenanceSchema.safeParse(input.provenance)
      if (!provenance.success || !input.turnId || !input.sessionId) return { ok: false, reason: 'invalid' }
      if (input.kind !== undefined && !ARTIFACT_KINDS.includes(input.kind)) return { ok: false, reason: 'invalid' }
      if (!isAbsolute(input.path) || normalize(input.path) !== input.path) return { ok: false, reason: 'invalid-path' }
      if (isExecutableType(input.path)) return { ok: false, reason: 'blocked-type' }
      const stat = await deps.fs.lstat(input.path)
      if (!stat || stat.isSymbolicLink() || !stat.isFile()) return { ok: false, reason: 'not-a-file' }
      let sha256: string
      try {
        sha256 = await deps.fs.sha256(input.path)
      } catch {
        return { ok: false, reason: 'unreadable' }
      }
      const after = await deps.fs.lstat(input.path)
      if (!after || after.size !== stat.size) return { ok: false, reason: 'unreadable' }
      const record: ArtifactRecord = {
        artifactId: newId(),
        turnId: input.turnId,
        sessionId: input.sessionId,
        kind: input.kind ?? artifactKindOf(input.path),
        displayName: safeDisplayName(input.displayName ?? input.path),
        path: input.path,
        bytes: stat.size,
        sha256,
        createdAt: deps.now(),
        provenance: provenance.data
      }
      records.set(record.artifactId, { owner, record })
      for (const key of records.keys()) {
        if (records.size <= limit) break
        records.delete(key)
      }
      return { ok: true, record }
    },
    get(artifactId) {
      const entry = records.get(artifactId)
      return entry && entry.owner === deps.owner() ? entry.record : null
    },
    outputManifest(turnId) {
      const owner = deps.owner()
      const artifactIds: string[] = []
      for (const [id, entry] of records) {
        if (entry.owner === owner && entry.record.turnId === turnId) artifactIds.push(id)
      }
      return { turnId, artifactIds: artifactIds.slice(0, 32) }
    },
    clear() {
      records.clear()
    }
  }
}
