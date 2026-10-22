import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Settings } from '@shared/ipc'
import {
  AccountEntitySchema,
  DealEntitySchema,
  PersonEntitySchema,
  type AccountEntity,
  type DealEntity,
  type PersonEntity
} from '@shared/brain'
import { decodeSavedResult } from '../transcripts'
import { readStableSnapshotBytes } from '../infra/storage/stable-read'
import { brainDir } from './brain-root'
import { migrateAccount, migrateDeal, migratePerson } from './entity-migrate'

// Bounded, uncached reads of one entity record for answer-context assembly (split out of store.ts).

export type BrainEntityKind = 'person' | 'account' | 'deal'

export type BrainEntityByKind = {
  person: PersonEntity
  account: AccountEntity
  deal: DealEntity
}

export interface BrainEntitySnapshot<K extends BrainEntityKind> {
  kind: K
  slug: string
  value: BrainEntityByKind[K]
  /** Digest and size of the exact on-disk bytes decoded and parsed into `value`. */
  digest: string
  size: number
}

export const MAX_BRAIN_ENTITY_SNAPSHOT_BYTES = 256 * 1024

/**
 * Uncached entity read for answer-context assembly. Decoding, parsing, migration, and digesting all use
 * the same bounded byte buffer, so a stale JSON cache entry can never be paired with a newer digest.
 */
export async function readBrainEntitySnapshot<K extends BrainEntityKind>(
  settings: Settings,
  kind: K,
  slug: string
): Promise<BrainEntitySnapshot<K> | null> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null
  const rootPath = brainDir(settings)
  const bytes = await readStableSnapshotBytes(
    rootPath,
    join(rootPath, 'entities', kind, `${slug}.json`),
    MAX_BRAIN_ENTITY_SNAPSHOT_BYTES
  )
  if (!bytes) return null
  const decoded = decodeSavedResult(bytes)
  if (!decoded.ok) return null
  try {
    const raw: unknown = JSON.parse(decoded.text)
    let value: PersonEntity | AccountEntity | DealEntity
    switch (kind) {
      case 'person':
        value = migratePerson(PersonEntitySchema.parse(raw), slug)
        break
      case 'account':
        value = migrateAccount(AccountEntitySchema.parse(raw), slug)
        break
      case 'deal':
        value = migrateDeal(DealEntitySchema.parse(raw), slug)
        break
    }
    return {
      kind,
      slug,
      value: value as BrainEntityByKind[K],
      digest: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length
    }
  } catch {
    return null
  }
}

/** Stable raw-byte digest for dispatch-time revalidation; no JSON cache or parse is involved. */
export async function readBrainEntityFingerprint(
  settings: Settings,
  kind: BrainEntityKind,
  slug: string
): Promise<{ digest: string; size: number } | null> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null
  const rootPath = brainDir(settings)
  const bytes = await readStableSnapshotBytes(
    rootPath,
    join(rootPath, 'entities', kind, `${slug}.json`),
    MAX_BRAIN_ENTITY_SNAPSHOT_BYTES
  )
  return bytes ? { digest: createHash('sha256').update(bytes).digest('hex'), size: bytes.length } : null
}
