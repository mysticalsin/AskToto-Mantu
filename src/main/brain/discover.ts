import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, normalize, resolve } from 'node:path'
import { homedir } from 'node:os'
import { app } from 'electron'
import type { Settings, SecondBrainCandidate } from '@shared/ipc'
import { detectOneDrive, resolveMeetingsFolder } from '../transcripts'

export type { SecondBrainCandidate }

/**
 * Hunt for an existing on-device "second brain" — a meetings folder that already has Métis's
 * `.brain/` store and/or a published `wiki/` mirror (CLAUDE.md / AGENTS.md).
 *
 * Why this exists: users reinstall, switch machines, or point meetings at a fresh folder and lose
 * the CRM/wiki that still sits next to an older OneDrive/Documents `Métis Meetings` (or legacy
 * `AskToto Meetings`) tree. Settings → Meetings can run this scan and reconnect `meetingsFolder`
 * without forcing a blind folder picker.
 *
 * Scope is intentionally shallow: known sync/document roots + one directory level of children.
 * No full-disk walk — that would be slow, noisy, and a privacy footgun.
 */

const KNOWN_MEETING_NAMES = new Set(['métis meetings', 'metis meetings', 'asktoto meetings'])

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function normKey(path: string): string {
  // Lowercase + normalize so Windows drive-letter and Unicode folder-name variants collapse.
  return normalize(resolve(path)).replace(/\\/g, '/').toLowerCase()
}

function countMeetings(folder: string): number {
  let n = 0
  for (const name of safeReaddir(folder)) {
    if (!name.endsWith('.md')) continue
    if (name === 'README.md' || name === 'index.md') continue
    n += 1
  }
  return n
}

/** Exported for connectSecondBrain — reject paths that are not a real second-brain folder. */
export function inspectSecondBrainFolder(
  folder: string,
  currentFolder?: string
): SecondBrainCandidate | null {
  const currentKey = currentFolder ? normKey(currentFolder) : ''
  if (!isDir(folder)) return null
  const brainIndex = join(folder, '.brain', 'index.json')
  const brainDirPath = join(folder, '.brain')
  const hasBrain = existsSync(brainIndex) || (existsSync(brainDirPath) && isDir(brainDirPath))
  const wiki = join(folder, 'wiki')
  const hasWiki =
    existsSync(join(wiki, 'CLAUDE.md')) ||
    existsSync(join(wiki, 'AGENTS.md')) ||
    existsSync(join(wiki, 'index.md'))
  const nameHit = KNOWN_MEETING_NAMES.has(basename(folder).toLowerCase())
  const meetingCount = countMeetings(folder)
  // Require a real signal — a random empty "Meetings" folder is not a second brain.
  if (!hasBrain && !hasWiki && !(nameHit && meetingCount > 0)) return null

  const signals: string[] = []
  if (hasBrain) signals.push('Has .brain knowledge store')
  if (hasWiki) signals.push('Has published wiki')
  if (nameHit) signals.push(`Named “${basename(folder)}”`)
  if (meetingCount > 0) signals.push(`${meetingCount} meeting${meetingCount === 1 ? '' : 's'}`)

  return {
    path: resolve(folder),
    label: basename(folder),
    hasBrain,
    hasWiki,
    meetingCount,
    isCurrent: currentKey !== '' && normKey(folder) === currentKey,
    signals
  }
}

/** Candidate parent roots to scan (OneDrive, Documents, Desktop, home, CloudStorage, …). */
export function secondBrainSearchRoots(extra: string[] = []): string[] {
  const roots: string[] = []
  const push = (p: string | undefined | null): void => {
    if (!p) return
    const abs = resolve(p)
    if (!isDir(abs)) return
    if (roots.some((r) => normKey(r) === normKey(abs))) return
    roots.push(abs)
  }

  for (const e of extra) push(e)

  // Prefer every OneDrive-shaped env the OS exposes (commercial + consumer can both exist).
  if (process.platform === 'win32') {
    for (const e of [
      process.env.OneDriveCommercial,
      process.env.OneDrive,
      process.env.OneDriveConsumer
    ]) {
      push(e)
    }
  }
  push(detectOneDrive())

  try {
    push(app.getPath('documents'))
  } catch {
    /* app not ready in some unit tests */
  }
  try {
    push(app.getPath('desktop'))
  } catch {
    /* ignore */
  }
  push(homedir())

  // macOS iCloud Drive / third-party cloud sync roots often hold a relocated meetings folder.
  if (process.platform === 'darwin') {
    push(join(homedir(), 'Library', 'CloudStorage'))
    push(join(homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs'))
  }

  return roots
}

/**
 * Shallow hunt: each root itself, known meeting-folder names under it, and one level of children
 * that look like a brain/wiki. Also peeks one level into CloudStorage vendor folders.
 */
export function discoverSecondBrains(
  settings: Settings,
  opts: { roots?: string[]; currentFolder?: string } = {}
): SecondBrainCandidate[] {
  const current = opts.currentFolder ?? resolveMeetingsFolder(settings)
  const roots = opts.roots ?? secondBrainSearchRoots([dirname(current), current])
  const byKey = new Map<string, SecondBrainCandidate>()

  const consider = (folder: string): void => {
    const hit = inspectSecondBrainFolder(folder, current)
    if (!hit) return
    const key = normKey(hit.path)
    const prev = byKey.get(key)
    if (!prev || hit.signals.length > prev.signals.length) byKey.set(key, hit)
  }

  const scanChildren = (root: string, deeperCloud = false): void => {
    consider(root)
    for (const name of ['Métis Meetings', 'Metis Meetings', 'AskToto Meetings']) {
      consider(join(root, name))
    }
    for (const name of safeReaddir(root)) {
      if (name.startsWith('.')) continue
      const child = join(root, name)
      if (!isDir(child)) continue
      consider(child)
      // CloudStorage vendors (OneDrive-*, Dropbox, …): one extra level for Métis Meetings.
      if (deeperCloud) {
        for (const nested of ['Métis Meetings', 'Metis Meetings', 'AskToto Meetings']) {
          consider(join(child, nested))
        }
      }
    }
  }

  for (const root of roots) {
    const deep = /cloudstorage/i.test(root) || /mobile documents/i.test(root)
    scanChildren(root, deep)
  }

  // Stable order: current first, then brains with wiki, then by meeting count, then path.
  return [...byKey.values()].sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
    if (a.hasBrain !== b.hasBrain) return a.hasBrain ? -1 : 1
    if (a.hasWiki !== b.hasWiki) return a.hasWiki ? -1 : 1
    if (b.meetingCount !== a.meetingCount) return b.meetingCount - a.meetingCount
    return a.path.localeCompare(b.path)
  })
}
