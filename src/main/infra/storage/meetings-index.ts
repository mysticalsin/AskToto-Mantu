import { app } from 'electron'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { readMeetingFields as frontmatter } from './meeting-document'
import type { ContentVersion, StorageGateway } from './gateway'
import { decodeSaved, decodeSavedResult, writeSaved } from './saved-file'

export const MEETINGS_INDEX_FILE = 'meetings-index.c5.json'
export const MEETINGS_INDEX_SCHEMA_VERSION = 1

const ContentVersionSchema = z.object({
  mtimeMs: z.number().finite(),
  ctimeMs: z.number().finite(),
  size: z.number().nonnegative()
})

const MeetingsIndexEntrySchema = z.object({
  file: z.string().min(1),
  title: z.string(),
  date: z.string(),
  mode: z.string(),
  durationMin: z.number().nonnegative(),
  participants: z.array(z.string()),
  topics: z.array(z.string()).optional(),
  confidential: z.literal(true).optional(),
  localState: z.enum(['local', 'not-downloaded', 'unavailable']),
  version: ContentVersionSchema
})

const MeetingsIndexRootSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  entries: z.array(MeetingsIndexEntrySchema)
})

const MeetingsIndexSchema = z.object({
  schema_version: z.literal(MEETINGS_INDEX_SCHEMA_VERSION),
  rebuilt_at: z.string(),
  roots: z.array(MeetingsIndexRootSchema)
})

export type MeetingsIndexEntry = z.infer<typeof MeetingsIndexEntrySchema>
export type MeetingsIndexRoot = z.infer<typeof MeetingsIndexRootSchema>
export type MeetingsIndex = z.infer<typeof MeetingsIndexSchema>

export interface MeetingsIndexListingRoot {
  id: string
  path: string
  gateway: StorageGateway
}

export type MeetingsIndexLoad =
  | { status: 'loaded'; index: MeetingsIndex }
  | { status: 'rebuilt'; index: MeetingsIndex }

export function meetingsIndexPath(userData = app.getPath('userData')): string {
  return join(userData, MEETINGS_INDEX_FILE)
}

export async function writeMeetingsIndex(index: MeetingsIndex, userData?: string): Promise<void> {
  const path = meetingsIndexPath(userData)
  const parsed = MeetingsIndexSchema.parse(index)
  await mkdir(dirname(path), { recursive: true })
  await writeSaved(path, JSON.stringify(parsed, null, 2), true)
}

export async function readMeetingsIndex(userData?: string): Promise<MeetingsIndex | null> {
  const path = meetingsIndexPath(userData)
  try {
    const decoded = decodeSavedResult(await readFile(path))
    if (!decoded.ok) return null
    return MeetingsIndexSchema.parse(JSON.parse(decoded.text))
  } catch {
    return null
  }
}

export async function loadOrRebuildMeetingsIndex(options: {
  roots: readonly MeetingsIndexListingRoot[]
  userData?: string
  now?: () => Date
}): Promise<MeetingsIndexLoad> {
  const current = await readMeetingsIndex(options.userData)
  if (current) return { status: 'loaded', index: current }
  const rebuilt = await rebuildMeetingsIndexFromListings(options.roots, options.now)
  if (rebuilt.roots.length === options.roots.length) await writeMeetingsIndex(rebuilt, options.userData)
  return { status: 'rebuilt', index: rebuilt }
}

export async function rebuildMeetingsIndexFromListings(
  roots: readonly MeetingsIndexListingRoot[],
  now: () => Date = () => new Date()
): Promise<MeetingsIndex> {
  const indexedRoots: MeetingsIndexRoot[] = []
  for (const root of roots) {
    const listing = await root.gateway.list('')
    if (listing.status !== 'ok') continue
    const names = listing.names.filter(isCandidateMeetingFile).sort()
    const classes = await root.gateway.classify(names)
    const entries: MeetingsIndexEntry[] = []
    for (const file of names) {
      const fileClass = classes.get(file)
      if (!fileClass || fileClass.status === 'missing') continue
      if (!('version' in fileClass) || !fileClass.isRegular) {
        entries.push(stubEntry(file, 'unavailable', { mtimeMs: 0, ctimeMs: 0, size: 0 }))
        continue
      }
      if (fileClass.status !== 'ok') {
        entries.push(stubEntry(file, 'not-downloaded', fileClass.version))
        continue
      }
      const read = await root.gateway.read(file)
      if (read.status !== 'ok') {
        entries.push(stubEntry(file, 'unavailable', fileClass.version))
        continue
      }
      const text = decodeSaved(read.bytes)
      entries.push(text ? entryFromText(file, read.version, text) : stubEntry(file, 'unavailable', read.version))
    }
    indexedRoots.push({ id: root.id, path: root.path, entries: entries.sort(compareEntries) })
  }
  return { schema_version: MEETINGS_INDEX_SCHEMA_VERSION, rebuilt_at: now().toISOString(), roots: indexedRoots }
}

function isCandidateMeetingFile(name: string): boolean {
  return name.endsWith('.md') && name !== 'README.md' && name !== 'index.md'
}

function splitList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean)
}

function durationMinutes(value: string | undefined): number {
  const duration = Number(value || 0)
  return Number.isFinite(duration) && duration >= 0 ? duration : 0
}

const STAMP = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})-/

function dateFromFile(file: string): string {
  const match = file.match(STAMP)
  if (!match) return ''
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.000Z`)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

function titleFromFile(file: string): string {
  return file.replace(/\.md$/, '').replace(STAMP, '').replace(/-/g, ' ').trim() || file
}

function stubEntry(file: string, localState: MeetingsIndexEntry['localState'], version: ContentVersion): MeetingsIndexEntry {
  return {
    file,
    title: titleFromFile(file),
    date: dateFromFile(file),
    mode: 'general',
    durationMin: 0,
    participants: [],
    localState,
    version
  }
}

function entryFromText(file: string, version: ContentVersion, text: string): MeetingsIndexEntry {
  const fm = frontmatter(text)
  const topics = splitList(fm.topics)
  return {
    file,
    title: fm.title || titleFromFile(file),
    date: fm.date || dateFromFile(file),
    mode: fm.mode || 'general',
    durationMin: durationMinutes(fm.duration_min),
    participants: splitList(fm.participants),
    ...(topics.length > 0 ? { topics } : {}),
    ...(fm.confidential === 'true' ? { confidential: true } : {}),
    localState: 'local',
    version
  }
}

function compareEntries(a: MeetingsIndexEntry, b: MeetingsIndexEntry): number {
  const byDate = (b.date || '').localeCompare(a.date || '')
  return byDate || a.file.localeCompare(b.file)
}
