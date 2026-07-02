import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import type { Settings } from '@shared/ipc'
import {
  BrainIndexSchema,
  BrainGraphSchema,
  PersonEntitySchema,
  AccountEntitySchema,
  DealEntitySchema,
  MeetingExtractionSchema,
  type BrainIndex,
  type BrainGraph,
  type PersonEntity,
  type AccountEntity,
  type DealEntity,
  type MeetingExtraction
} from '@shared/brain'
import { resolveMeetingsFolder, readSavedFile, writeSaved } from '../transcripts'

/**
 * Brain store — plain JSON files under `<meetings folder>/.brain/`.
 *
 * Lives NEXT TO the transcripts on purpose: it inherits the user's folder choice, OneDrive sync (so
 * Dust agents can read it as vault context), and — critically — the same at-rest encryption setting.
 * When encryptTranscripts is on, every brain file is written through the same ATKENC envelope as the
 * transcripts themselves (writeSaved/readSavedFile handle both forms transparently).
 */

export function brainDir(settings: Settings): string {
  return join(resolveMeetingsFolder(settings), '.brain')
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '') // strip diacritics so "L'Oréal" and "L'Oreal" share a slug
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'unknown'
  )
}

function ensureDirs(settings: Settings): string {
  const root = brainDir(settings)
  for (const d of [root, join(root, 'meetings'), join(root, 'entities', 'person'), join(root, 'entities', 'account'), join(root, 'entities', 'deal')]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
  }
  return root
}

function readJson<T>(settings: Settings, rel: string, parse: (v: unknown) => T): T | null {
  const p = join(brainDir(settings), rel)
  if (!existsSync(p)) return null
  try {
    return parse(JSON.parse(readSavedFile(p)))
  } catch {
    return null // corrupt/undecryptable file — callers treat as absent; ingest will rewrite it
  }
}

async function writeJson(settings: Settings, rel: string, value: unknown): Promise<void> {
  ensureDirs(settings)
  const p = join(brainDir(settings), rel)
  await writeSaved(p, JSON.stringify(value, null, 2), !!settings.encryptTranscripts)
}

// ── Typed accessors ──────────────────────────────────────────────────────────

export const readIndex = (s: Settings): BrainIndex =>
  readJson(s, 'index.json', (v) => BrainIndexSchema.parse(v)) ?? BrainIndexSchema.parse({})
export const writeIndex = (s: Settings, v: BrainIndex): Promise<void> => writeJson(s, 'index.json', v)

export const readGraph = (s: Settings): BrainGraph =>
  readJson(s, 'graph.json', (v) => BrainGraphSchema.parse(v)) ?? BrainGraphSchema.parse({})
export const writeGraph = (s: Settings, v: BrainGraph): Promise<void> => writeJson(s, 'graph.json', v)

export const readMeetingExtraction = (s: Settings, fileSlug: string): MeetingExtraction | null =>
  readJson(s, join('meetings', `${fileSlug}.json`), (v) => MeetingExtractionSchema.parse(v))
export const writeMeetingExtraction = (s: Settings, fileSlug: string, v: MeetingExtraction): Promise<void> =>
  writeJson(s, join('meetings', `${fileSlug}.json`), v)

export const readPerson = (s: Settings, slug: string): PersonEntity | null =>
  readJson(s, join('entities', 'person', `${slug}.json`), (v) => PersonEntitySchema.parse(v))
export const writePerson = (s: Settings, slug: string, v: PersonEntity): Promise<void> =>
  writeJson(s, join('entities', 'person', `${slug}.json`), v)

export const readAccount = (s: Settings, slug: string): AccountEntity | null =>
  readJson(s, join('entities', 'account', `${slug}.json`), (v) => AccountEntitySchema.parse(v))
export const writeAccount = (s: Settings, slug: string, v: AccountEntity): Promise<void> =>
  writeJson(s, join('entities', 'account', `${slug}.json`), v)

export const readDeal = (s: Settings, slug: string): DealEntity | null =>
  readJson(s, join('entities', 'deal', `${slug}.json`), (v) => DealEntitySchema.parse(v))
export const writeDeal = (s: Settings, slug: string, v: DealEntity): Promise<void> =>
  writeJson(s, join('entities', 'deal', `${slug}.json`), v)

/** List entity slugs of a kind (file basenames sans .json). */
export function listEntities(s: Settings, kind: 'person' | 'account' | 'deal'): string[] {
  const dir = join(brainDir(s), 'entities', kind)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => basename(f, '.json'))
}

export function listMeetingExtractions(s: Settings): string[] {
  const dir = join(brainDir(s), 'meetings')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => basename(f, '.json'))
}
