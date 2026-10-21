/**
 * Gateway-backed view of the meeting sources Intelligence may inspect.
 *
 * Listing/classification is metadata-only. Transcript bytes are opened only by readSourceText(), after
 * the storage gateway has classified the file as local.
 */
import { getMeetingSpeechReadLimitBytes, publicMeetingTextAsync } from '../features/meetings/meeting-speech'
import { basename, dirname, join } from 'node:path'
import { realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { Settings } from '@shared/ipc'
import type { BrainIndex } from '@shared/brain'
import { fnv1a } from '@shared/hash'
import { storageAt, classifyAll } from '../infra/storage/meetings-storage'
import type { ContentVersion, StorageGateway } from '../infra/storage/gateway'
import { canonicalPath, readStableRegularFile } from '../infra/storage/stable-read'
import { decodeSavedMeetingAsync, resolveMeetingsFolder } from '../transcripts'
import { mainLog } from '../logger'
import { brainDir, readIndex, slugify } from './store'

const MAX_BRAIN_CONTEXT_SOURCE_BYTES = 16 * 1024 * 1024

export interface MeetingSource {
  key: string
  file: string
  source: 'meetings' | 'team'
  label?: string
  sourceRootId: string
  version?: string
  changedAtMs?: number
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
export type SourceText =
  | { status: 'ok'; text: string; observation: SourceObservation }
  | { status: 'missing' }
  | { status: 'not-on-device'; observation: SourceObservation }
  | { status: 'unreadable'; error: unknown; observation: SourceObservation }
export type SourceObservation = {
  version?: string
  changedAtMs?: number
  /** SHA-256 of the exact bounded stored bytes read to produce extraction text. */
  sourceDigest?: string
  /** SHA-256 of the canonical root path; never sent to renderer/provider. */
  sourceRootId?: string
}

export function isMeetingTranscriptFile(name: string): boolean {
  return name.endsWith('.md') && !name.startsWith('.') && name !== 'index.md' && name !== 'README.md'
}

export function formatSourceVersion({ mtimeMs, size }: { mtimeMs: number; size: number }): string {
  return `${Math.round(mtimeMs)}:${size}`
}

/** Opaque stable identity for a configured source root. Raw paths remain in Main. */
export async function canonicalSourceRootId(root: string): Promise<string | null> {
  try {
    const canonical = await realpath(root)
    return createHash('sha256').update(canonical, 'utf8').digest('hex')
  } catch {
    return null
  }
}

function observationOf(version: ContentVersion): SourceObservation {
  return { version: formatSourceVersion(version), changedAtMs: Math.round(version.ctimeMs) }
}

async function scanFolder(root: string, source: 'meetings' | 'team', label?: string): Promise<SourceFolder> {
  const rootId = await canonicalSourceRootId(root)
  const gateway = storageAt(root)
  const listing = await gateway.list('')
  if (listing.status === 'missing') {
    // The gateway folds ENOTDIR into "missing"; an existing non-directory root is a failed listing.
    const self = (await gateway.classify([''])).get('')
    return { root, source, label, status: self?.status === 'missing' ? 'missing' : 'failed', sources: [] }
  }
  if (listing.status !== 'ok' || !rootId) return { root, source, label, status: 'failed', sources: [] }
  const names = listing.names.filter(isMeetingTranscriptFile)
  const classes = await classifyAll(gateway, names)
  const sources: MeetingSource[] = []
  for (const name of names) {
    const fileClass = classes.get(name)
    if (!fileClass || fileClass.status === 'missing') continue
    const key = source === 'meetings' ? name : `team/${label ?? 'team'}/${name}`
    const observation = 'version' in fileClass ? observationOf(fileClass.version) : {}
    sources.push({
      key,
      file: join(root, name),
      source,
      ...(label ? { label } : {}),
      sourceRootId: rootId,
      ...observation,
      local: fileClass.status === 'ok'
    })
  }
  return { root, source, label, status: 'ok', sources }
}

export async function scanMeetingSources(s: Settings): Promise<SourceScan> {
  const folders: Array<{ root: string; source: 'meetings' | 'team'; label?: string }> = [
    { root: resolveMeetingsFolder(s), source: 'meetings' }
  ]
  for (const root of s.teamTranscriptFolders ?? []) {
    if (root) folders.push({ root, source: 'team', label: basename(root) || 'team' })
  }
  const scans = await Promise.all(folders.map((folder) => scanFolder(folder.root, folder.source, folder.label)))
  const sourceKeys = new Set<string>()
  let collision = false
  for (const folder of scans) {
    for (const source of folder.sources) {
      if (sourceKeys.has(source.key)) collision = true
      sourceKeys.add(source.key)
    }
  }
  // Legacy team IDs use only the root basename. Two authorized roots can therefore collide on one key;
  // do not let map overwrite order select a source silently. Context resolution below still uses rootId.
  return collision ? scans.map((folder) => ({ ...folder, status: 'failed' as const })) : scans
}

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
  let count = 0
  for (const folder of scan) {
    if (folder.status !== 'ok') continue
    for (const source of folder.sources) if (!idx.ingested[source.key]?.ok) count += 1
  }
  return count
}

export async function readSourceText(file: string): Promise<SourceText> {
  const maxBytes = getMeetingSpeechReadLimitBytes()
  if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes < 1)
    return { status: 'unreadable', error: new Error('Meeting read limit is unavailable.'), observation: {} }
  const root = dirname(file)
  const rootId = await canonicalSourceRootId(root)
  if (!rootId) return { status: 'unreadable', error: new Error('Meeting source root is unavailable.'), observation: {} }
  const gateway = storageAt(root)
  const name = basename(file)
  const classification = (await classifyAll(gateway, [name])).get(name)
  if (!classification || classification.status !== 'ok' || classification.isSymlink || !classification.isRegular) {
    const observation = classification && 'version' in classification ? observationOf(classification.version) : {}
    return { status: 'unreadable', error: new Error('Meeting source is not a regular file.'), observation }
  }
  const read = await gateway.read(name, { maxBytes })
  const observation: SourceObservation =
    'version' in read ? { ...observationOf(read.version), sourceRootId: rootId } : { sourceRootId: rootId }
  if (read.status === 'ok') {
    const version = read.version
    if (
      version.mtimeMs !== classification.version.mtimeMs ||
      version.ctimeMs !== classification.version.ctimeMs ||
      version.size !== classification.version.size ||
      version.size !== read.bytes.length ||
      read.bytes.length > maxBytes ||
      (await canonicalSourceRootId(root)) !== rootId
    ) {
      return { status: 'unreadable', error: new Error('Meeting source changed while it was read.'), observation }
    }
    try {
      const decoded = await decodeSavedMeetingAsync(read.bytes, false, file)
      if (!decoded.ok)
        return { status: 'unreadable', error: new Error('Meeting file could not be decrypted.'), observation }
      return {
        status: 'ok',
        text: await publicMeetingTextAsync(decoded.text),
        observation: { ...observation, sourceDigest: createHash('sha256').update(read.bytes).digest('hex') }
      }
    } catch {
      return { status: 'unreadable', error: new Error('Meeting text could not be projected safely.'), observation }
    }
  }
  if (read.status === 'missing') return { status: 'missing' }
  if (read.status === 'dataless' || read.status === 'unknown') return { status: 'not-on-device', observation }
  return {
    status: 'unreadable',
    error: new Error(read.status === 'unavailable' ? read.code : read.status),
    observation
  }
}

/** Re-read a source by its persisted key and root receipt; ambiguous or legacy identities fail closed. */
export async function readSourceDigest(s: Settings, sourceKey: string, expectedRootId: string): Promise<string | null> {
  if (!/^[a-f0-9]{64}$/.test(expectedRootId) || typeof sourceKey !== 'string' || sourceKey.length > 512) return null
  const personalRoot = resolveMeetingsFolder(s)
  const candidates: Array<{ root: string; label?: string; source: 'meetings' | 'team' }> = [
    { root: personalRoot, source: 'meetings' },
    ...(s.teamTranscriptFolders ?? [])
      .filter(Boolean)
      .map((root) => ({ root, label: basename(root) || 'team', source: 'team' as const }))
  ]
  const matches: string[] = []
  for (const candidate of candidates) {
    if ((await canonicalSourceRootId(candidate.root)) !== expectedRootId) continue
    if (candidate.source === 'meetings') {
      if (basename(sourceKey) === sourceKey && !sourceKey.includes('\\')) matches.push(candidate.root)
    } else {
      const match = sourceKey.match(/^team\/([^/]+)\/([^/]+)$/)
      if (match && match[1] === candidate.label && basename(match[2]) === match[2] && !match[2].includes('\\')) {
        matches.push(candidate.root)
      }
    }
  }
  if (sourceKey.startsWith('team/')) {
    const label = sourceKey.split('/')[1]
    if (candidates.filter((candidate) => candidate.source === 'team' && candidate.label === label).length !== 1)
      return null
  }
  const roots = [...new Set(matches)]
  if (roots.length !== 1) return null
  const root = roots[0]!
  const name = sourceKey.includes('/') ? sourceKey.slice(sourceKey.lastIndexOf('/') + 1) : sourceKey
  if (!isMeetingTranscriptFile(name)) return null
  const maxBytes = getMeetingSpeechReadLimitBytes()
  if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes < 1) return null
  const gateway = storageAt(root)
  const classification = (await classifyAll(gateway, [name])).get(name)
  if (!classification || classification.status !== 'ok' || classification.isSymlink || !classification.isRegular)
    return null
  const read = await gateway.read(name, { maxBytes })
  if (
    read.status !== 'ok' ||
    read.version.size !== read.bytes.length ||
    read.bytes.length > maxBytes ||
    read.version.mtimeMs !== classification.version.mtimeMs ||
    read.version.ctimeMs !== classification.version.ctimeMs ||
    read.version.size !== classification.version.size ||
    (await canonicalSourceRootId(root)) !== expectedRootId
  )
    return null
  return createHash('sha256').update(read.bytes).digest('hex')
}

/** Dispatch-time proof over one bounded file descriptor per source (see stable-read.ts), after resolving only an
 * authorized configured root. This keeps provider retries from dispatching stale/ambiguous sources. */
export async function areBrainContextSourcesCurrent(
  s: Settings,
  references: readonly { source: string; sourceRootId: string; sourceDigest: string }[] | undefined
): Promise<boolean> {
  if (!Array.isArray(references) || references.length < 1 || references.length > 64) return false
  const index = readIndex(s)
  const personalRoot = resolveMeetingsFolder(s)
  const roots = [
    { root: personalRoot, source: 'meetings' as const },
    ...(s.teamTranscriptFolders ?? []).filter(Boolean).map((root) => ({ root, source: 'team' as const }))
  ]
  const seen = new Set<string>()
  let totalBytes = 0
  for (const ref of references) {
    if (
      !ref ||
      typeof ref.source !== 'string' ||
      ref.source.length > 512 ||
      !/^[a-f0-9]{64}$/.test(ref.sourceRootId) ||
      !/^[a-f0-9]{64}$/.test(ref.sourceDigest)
    )
      return false
    const duplicateKey = `${ref.sourceRootId}\0${ref.source}`
    if (seen.has(duplicateKey)) continue
    seen.add(duplicateKey)
    const receipt = index.ingested[ref.source]
    if (!receipt?.ok || receipt.sourceRootId !== ref.sourceRootId || receipt.sourceDigest !== ref.sourceDigest)
      return false
    const canonicals = await Promise.all(roots.map(({ root }) => canonicalPath(root)))
    const matches = roots.filter(({ root, source }, i) => {
      const canonical = canonicals[i]
      if (!canonical || createHash('sha256').update(canonical, 'utf8').digest('hex') !== ref.sourceRootId) return false
      if (source === 'meetings') return basename(ref.source) === ref.source && !ref.source.includes('\\')
      const key = ref.source.match(/^team\/([^/]+)\/([^/]+)$/)
      return !!key && key[2] === basename(key[2]) && !key[2].includes('\\') && key[1] === (basename(root) || 'team')
    })
    if (ref.source.startsWith('team/')) {
      const label = ref.source.split('/')[1]
      if (roots.filter(({ root, source }) => source === 'team' && (basename(root) || 'team') === label).length !== 1)
        return false
    }
    const uniqueRoots = [...new Set(matches.map(({ root }) => root))]
    if (uniqueRoots.length !== 1) return false
    const name = basename(ref.source)
    if (!isMeetingTranscriptFile(name)) return false
    const root = uniqueRoots[0]!
    const maxBytes = getMeetingSpeechReadLimitBytes()
    if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes < 1) return false
    const read = await readStableRegularFile(root, name, maxBytes)
    if (read.status !== 'ok') return false
    if (createHash('sha256').update(read.canonicalRoot, 'utf8').digest('hex') !== ref.sourceRootId) return false
    totalBytes += read.bytes.length
    if (totalBytes > MAX_BRAIN_CONTEXT_SOURCE_BYTES) return false
    if (createHash('sha256').update(read.bytes).digest('hex') !== ref.sourceDigest) return false
  }
  return true
}

export async function sourceFileObservation(file: string): Promise<SourceObservation> {
  const name = basename(file)
  const fileClass = (await classifyAll(storageAt(dirname(file)), [name])).get(name)
  return fileClass && 'version' in fileClass ? observationOf(fileClass.version) : {}
}

const ENTITY_DIRS = [join('entities', 'person'), join('entities', 'account'), join('entities', 'deal')]
const pausedFolders = new Set<string>()

function isJournalFile(name: string): boolean {
  return name === 'corrections.json' || name.startsWith('corrections.')
}

async function mergeInputs(gateway: StorageGateway): Promise<string[] | null> {
  const dirs = ['.brain', ...ENTITY_DIRS.map((dir) => join('.brain', dir))]
  const listings = await Promise.all(dirs.map((dir) => gateway.list(dir)))
  const paths: string[] = []
  for (const [i, listing] of listings.entries()) {
    if (listing.status === 'missing') continue
    if (listing.status !== 'ok') return null
    const wanted =
      i === 0
        ? (name: string) => name === 'graph.json' || isJournalFile(name)
        : (name: string) => name.endsWith('.json')
    for (const name of listing.names) if (wanted(name)) paths.push(join(dirs[i], name))
  }
  return paths
}

export async function brainInputsLocal(s: Settings, scan?: SourceScan): Promise<boolean> {
  const gateway = storageAt(resolveMeetingsFolder(s))
  const inputs = await mergeInputs(gateway)
  let local =
    inputs !== null &&
    [...(await classifyAll(gateway, inputs)).values()].every(
      (fileClass) => fileClass.status === 'ok' || fileClass.status === 'missing'
    )
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

export function extractionSlug(key: string): string {
  return key.includes('/') ? `${slugify(key)}-${fnv1a(key).toString(16)}` : slugify(key)
}

export function hasSavedReconciliationCandidate(
  scan: SourceScan,
  idx: BrainIndex,
  extracted: ReadonlySet<string>
): boolean {
  const own = scan.find((folder) => folder.source === 'meetings')
  return (
    (own?.status === 'ok' &&
      own.sources.some((source) => !idx.ingested[source.key]?.ok && extracted.has(extractionSlug(source.key)))) ||
    false
  )
}
