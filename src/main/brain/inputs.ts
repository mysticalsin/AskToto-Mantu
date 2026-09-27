/**
 * What the brain may read, as the storage gateway sees it without reading: the meeting transcripts in the
 * meetings root and every team transcript folder, and whether the .brain files the synchronous merge, lint
 * and replay stages read are on this device. Scanning is metadata only (one list and one classify per
 * folder); a transcript is read only through readSourceText, which never opens a cloud-only file.
 */
import { basename, dirname, join } from 'node:path'
import type { Settings } from '@shared/ipc'
import type { BrainIndex } from '@shared/brain'
import { fnv1a } from '@shared/hash'
import { storageAt, classifyAll } from '../infra/storage/meetings-storage'
import type { StorageGateway } from '../infra/storage/gateway'
import { decodeSaved, resolveMeetingsFolder } from '../transcripts'
import { isJournalFile } from './corrections'
import { brainDir, slugify } from './store'
import { mainLog } from '../logger'

export interface MeetingSource {
  key: string
  file: string
  source: 'meetings' | 'team'
  label?: string
  version?: string
  local: boolean
}

export interface SourceFolder {
  root: string
  source: 'meetings' | 'team'
  label?: string
  status: 'ok' | 'missing' | 'failed'
  sources: MeetingSource[]
}

export type SourceScan = readonly SourceFolder[]

export type SourceText = { status: 'ok'; text: string } | { status: 'missing' } | { status: 'not-on-device' }

/** A `.md` file directly inside a source folder, excluding the plaintext debug index and hidden/docs files. */
export function isMeetingTranscriptFile(name: string): boolean {
  return name.endsWith('.md') && !name.startsWith('.') && name !== 'index.md' && name !== 'README.md'
}

export function formatSourceVersion({ mtimeMs, size }: { mtimeMs: number; size: number }): string {
  return `${Math.round(mtimeMs)}:${size}`
}

async function scanFolder(root: string, source: 'meetings' | 'team', label?: string): Promise<SourceFolder> {
  const gateway = storageAt(root)
  const listing = await gateway.list('')
  if (listing.status === 'missing') return { root, source, label, status: 'missing', sources: [] }
  if (listing.status !== 'ok') return { root, source, label, status: 'failed', sources: [] }
  const names = listing.names.filter(isMeetingTranscriptFile)
  const classes = await classifyAll(gateway, names)
  const sources: MeetingSource[] = []
  for (const name of names) {
    const fileClass = classes.get(name)
    if (!fileClass || fileClass.status === 'missing') continue
    const key = source === 'meetings' ? name : `team/${label}/${name}`
    const version = 'version' in fileClass ? formatSourceVersion(fileClass.version) : undefined
    sources.push({ key, file: join(root, name), source, label, version, local: fileClass.status === 'ok' })
  }
  return { root, source, label, status: 'ok', sources }
}

/** The meetings root first, then each configured team folder, in Settings order. */
export async function scanMeetingSources(s: Settings): Promise<SourceScan> {
  const folders: Array<{ root: string; source: 'meetings' | 'team'; label?: string }> = [
    { root: resolveMeetingsFolder(s), source: 'meetings' }
  ]
  for (const root of s.teamTranscriptFolders ?? []) {
    if (!root) continue
    folders.push({ root, source: 'team', label: basename(root) || 'team' })
  }
  return Promise.all(folders.map((f) => scanFolder(f.root, f.source, f.label)))
}

/** Every source's version, or null when any folder is not ok or any source has no version. */
export function sourceVersions(scan: SourceScan): Map<string, string> | null {
  const versions = new Map<string, string>()
  for (const folder of scan) {
    if (folder.status !== 'ok') return null
    for (const source of folder.sources) {
      if (!source.version) return null
      versions.set(source.key, source.version)
    }
  }
  return versions
}

export function hasSourceDrift(scan: SourceScan, idx: BrainIndex): boolean {
  const current = sourceVersions(scan)
  if (!current) return false
  for (const [file, record] of Object.entries(idx.ingested)) {
    if (!record.ok) continue
    const version = current.get(file)
    if (!version || !record.sourceVersion || record.sourceVersion !== version) return true
  }
  return false
}

export function hasIncompleteSource(scan: SourceScan, idx: BrainIndex): boolean {
  for (const folder of scan) {
    if (folder.status !== 'ok') return true
    if (folder.sources.some((source) => source.local && !idx.ingested[source.key]?.ok)) return true
  }
  return false
}

export function countUnextracted(scan: SourceScan, idx: BrainIndex): number {
  let n = 0
  for (const folder of scan) {
    if (folder.status !== 'ok') continue
    for (const source of folder.sources) if (!idx.ingested[source.key]?.ok) n++
  }
  return n
}

/** Sources are direct children of their folder, so dirname is the source's root. */
export async function readSourceText(file: string): Promise<SourceText> {
  const read = await storageAt(dirname(file)).read(basename(file))
  if (read.status === 'ok') return { status: 'ok', text: decodeSaved(read.bytes) }
  if (read.status === 'missing') return { status: 'missing' }
  return { status: 'not-on-device' }
}

/** Presence is irrelevant here — only the version, when the gateway could get one. */
export async function sourceFileVersion(file: string): Promise<{ mtimeMs: number; size: number } | null> {
  const name = basename(file)
  const classes = await classifyAll(storageAt(dirname(file)), [name])
  const fileClass = classes.get(name)
  return fileClass && 'version' in fileClass ? fileClass.version : null
}

const ENTITY_DIRS = [join('entities', 'person'), join('entities', 'account'), join('entities', 'deal')]
const pausedFolders = new Set<string>()

async function mergeInputs(gateway: StorageGateway): Promise<string[] | null> {
  const dirs = ['.brain', ...ENTITY_DIRS.map((dir) => join('.brain', dir))]
  const listings = await Promise.all(dirs.map((dir) => gateway.list(dir)))
  const paths: string[] = []
  for (const [i, listing] of listings.entries()) {
    if (listing.status === 'missing') continue
    if (listing.status !== 'ok') return null
    const wanted = i === 0 ? (name: string) => name === 'graph.json' || isJournalFile(name) : (name: string) => name.endsWith('.json')
    for (const name of listing.names) if (wanted(name)) paths.push(join(dirs[i], name))
  }
  return paths
}

/** True only when every file the synchronous brain stages would read is on this device. */
export async function brainInputsLocal(s: Settings, scan?: SourceScan): Promise<boolean> {
  const gateway = storageAt(resolveMeetingsFolder(s))
  const inputs = await mergeInputs(gateway)
  let local = inputs !== null && [...(await classifyAll(gateway, inputs)).values()].every((c) => c.status === 'ok' || c.status === 'missing')
  if (local && s.publishBrainPages) {
    const folders = scan ?? (await scanMeetingSources(s))
    local = folders.every((folder) => folder.status !== 'failed' && folder.sources.every((source) => source.local))
  }
  notePaused(brainDir(s), !local)
  return local
}

function notePaused(folder: string, paused: boolean): void {
  if (paused === pausedFolders.has(folder)) return
  if (paused) {
    pausedFolders.add(folder)
    mainLog.warn('[brain] some Intelligence files are not on this device; model work is paused until they are')
  } else {
    pausedFolders.delete(folder)
    mainLog.info('[brain] Intelligence files are on this device again; model work resumes')
  }
}

export function pausedForCloudOnlyInputs(s: Settings): boolean {
  return pausedFolders.has(brainDir(s))
}

export function extractionSlug(key: string): string {
  return key.includes('/') ? `${slugify(key)}-${fnv1a(key).toString(16)}` : slugify(key)
}

export function hasSavedReconciliationCandidate(
  scan: SourceScan,
  idx: BrainIndex,
  extracted: ReadonlySet<string>
): boolean {
  const own = scan.find((folder) => folder.source === 'meetings')
  return own?.status === 'ok' && own.sources.some((source) => !idx.ingested[source.key]?.ok && extracted.has(extractionSlug(source.key))) || false
}
