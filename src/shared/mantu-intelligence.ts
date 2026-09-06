/**
 * Mantu Intelligence — OneDrive brain scan, connect persistence, and cross-meeting Connections.
 *
 * Pure helpers. Main owns filesystem + settings writes. Renderer/dashboard only display results.
 * Name is Mantu Intelligence only. Never "Mountain Intelligence".
 *
 * Design: docs/design/MANTU-INTELLIGENCE.md
 */

export const PREFERRED_BRAIN_FOLDER = 'AI Second Brain'
export const PREFERRED_BRAIN_REL = ['Documents', 'AI Second Brain'] as const

export const BRAIN_FILE_MARKERS = ['llms.txt', 'CLAUDE.md'] as const
export const BRAIN_DIR_MARKERS = ['wiki', '.brain', '.obsidian'] as const

export type MeetingLinkKind = 'person' | 'account' | 'deal' | 'topic'

export interface MeetingRefLike {
  file: string
  title?: string
  date?: string
}

export interface MeetingConnection {
  id: string
  kind: MeetingLinkKind
  via: string
  a: { file: string; title: string }
  b: { file: string; title: string }
  sentence: string
}

export interface BrainScanHit {
  path: string
  label: string
  markers: string[]
  preferred: boolean
  score: number
  connected: boolean
}

export interface BrainScanResult {
  hits: BrainScanHit[]
  connectedPath: string
  scannedRoots: string[]
  error?: string
}

export function isBrainMarkerName(name: string): boolean {
  const n = name.replace(/[\\/]+$/, '').trim()
  if (!n) return false
  if (BRAIN_FILE_MARKERS.some((m) => m.toLowerCase() === n.toLowerCase())) return true
  if (BRAIN_DIR_MARKERS.some((m) => m.toLowerCase() === n.toLowerCase())) return true
  if (/^ai second brain$/i.test(n)) return true
  return nameLooksLikeBrain(n)
}

export function nameLooksLikeBrain(name: string): boolean {
  return /second\s*brain|llm\s*wiki|ai\s*wiki/i.test(name)
}

export function isMantuGroupRoot(root: string): boolean {
  return /OneDrive-MantuGroup|OneDrive - Mantu Group/i.test(root.replace(/\\/g, '/'))
}

export function isAbsoluteBrainPath(path: string): boolean {
  if (!path || path.includes('\0')) return false
  if (path.startsWith('/')) return true
  if (/^[A-Za-z]:[\\/]/.test(path)) return true
  if (path.startsWith('\\\\')) return true
  return false
}

export function normalizeConnectPath(raw: string): { ok: true; path: string } | { ok: false; error: string } {
  const path = raw.trim()
  if (!path) return { ok: false, error: 'Paste or pick a folder path first.' }
  if (path.includes('\0')) return { ok: false, error: 'That path is not valid.' }
  if (path.length > 1024) return { ok: false, error: 'That path is too long.' }
  if (!isAbsoluteBrainPath(path)) return { ok: false, error: 'Use a full folder path, not a relative one.' }
  return { ok: true, path }
}

/** Settings write that persists the meetings/brain root across relaunch. No second index. */
export function brainConnectSettingsPatch(path: string): { meetingsFolder: string } {
  return { meetingsFolder: path }
}

export function listOneDriveRoots(input: {
  platform: string
  homedir: string
  env: Record<string, string | undefined>
  cloudStorageNames?: string[]
}): string[] {
  const roots: string[] = []
  const add = (p: string): void => {
    const trimmed = p.trim()
    if (trimmed && !roots.includes(trimmed)) roots.push(trimmed)
  }

  if (input.platform === 'win32') {
    for (const e of [input.env.OneDriveCommercial, input.env.OneDrive, input.env.OneDriveConsumer]) {
      if (e) add(e)
    }
    add(joinPath(input.homedir, 'OneDrive'))
    add(joinPath(input.homedir, 'OneDrive - Mantu Group'))
    return roots
  }

  if (input.platform === 'darwin') {
    const base = joinPath(input.homedir, 'Library', 'CloudStorage')
    const names = [...(input.cloudStorageNames ?? [])].filter((n) => /^OneDrive/i.test(n))
    names.sort((a, b) => Number(isMantuGroupRoot(b)) - Number(isMantuGroupRoot(a)))
    for (const n of names) add(joinPath(base, n))
    add(joinPath(input.homedir, 'OneDrive'))
    return roots
  }

  add(joinPath(input.homedir, 'OneDrive'))
  return roots
}

export function preferredBrainPaths(roots: string[]): string[] {
  const out: string[] = []
  const mantu = roots.filter(isMantuGroupRoot)
  const rest = roots.filter((r) => !isMantuGroupRoot(r))
  for (const root of [...mantu, ...rest]) {
    out.push(joinPath(root, ...PREFERRED_BRAIN_REL))
    out.push(joinPath(root, PREFERRED_BRAIN_FOLDER))
  }
  return out
}

export function collectMarkerHits(names: string[]): string[] {
  const hits: string[] = []
  for (const name of names) {
    if (isBrainMarkerName(name)) hits.push(name)
  }
  return uniqueSorted(hits)
}

export function scoreBrainCandidate(input: {
  path: string
  folderName: string
  markers: string[]
  connected?: boolean
}): number {
  let score = 0
  const preferredName = /^ai second brain$/i.test(input.folderName)
  if (preferredName && isMantuGroupRoot(input.path)) score += 100
  else if (preferredName) score += 80
  else if (nameLooksLikeBrain(input.folderName)) score += 40

  const markers = new Set(input.markers.map((m) => m.toLowerCase()))
  if (markers.has('.brain') && markers.has('wiki')) score += 40
  else {
    if (markers.has('.brain')) score += 25
    if (markers.has('wiki')) score += 25
  }
  if (markers.has('llms.txt')) score += 15
  if (markers.has('claude.md')) score += 15
  if (markers.has('.obsidian')) score += 8
  if (input.connected) score += 5
  return score
}

export function rankBrainHits(hits: BrainScanHit[]): BrainScanHit[] {
  return [...hits].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.preferred !== b.preferred) return a.preferred ? -1 : 1
    return a.path.localeCompare(b.path)
  })
}

export function brainHitLabel(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  const name = parts[parts.length - 1] || path
  if (/^ai second brain$/i.test(name) && isMantuGroupRoot(path)) return 'AI Second Brain (Mantu OneDrive)'
  return name
}

export function connectionSentence(input: {
  kind: MeetingLinkKind
  via: string
  aTitle: string
  bTitle: string
}): string {
  const a = input.aTitle.trim() || 'Untitled meeting'
  const b = input.bTitle.trim() || 'Untitled meeting'
  const via = input.via.trim() || 'shared'
  if (input.kind === 'topic') return `${a} and ${b} share topic ${via}.`
  return `${a} and ${b} share ${input.kind} ${via}.`
}

export function buildMeetingConnections(input: {
  people?: Array<{ name: string; meetings?: MeetingRefLike[] }>
  accounts?: Array<{ name: string; meetings?: MeetingRefLike[] }>
  deals?: Array<{ name: string; meetings?: MeetingRefLike[] }>
  meetings?: Array<{ source_file?: string; title24?: string; topics?: string[] }>
}): MeetingConnection[] {
  const edges: MeetingConnection[] = []
  const titleByFile = new Map<string, string>()

  const remember = (file: string, title?: string): void => {
    const key = file.trim()
    if (!key) return
    const t = (title ?? '').trim()
    if (t && !titleByFile.has(key)) titleByFile.set(key, t)
  }

  for (const m of input.meetings ?? []) {
    if (m.source_file) remember(m.source_file, m.title24)
  }
  for (const group of [input.people, input.accounts, input.deals]) {
    for (const entity of group ?? []) {
      for (const m of entity.meetings ?? []) remember(m.file, m.title)
    }
  }

  const titleOf = (file: string): string => titleByFile.get(file) || file.replace(/\.md$/i, '')

  const addPairs = (kind: MeetingLinkKind, via: string, refs: MeetingRefLike[]): void => {
    const files = uniqueFiles(refs)
    if (files.length < 2) return
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const aFile = files[i]
        const bFile = files[j]
        const a = { file: aFile, title: titleOf(aFile) }
        const b = { file: bFile, title: titleOf(bFile) }
        const sentence = connectionSentence({ kind, via, aTitle: a.title, bTitle: b.title })
        edges.push({
          id: `${kind}:${via}:${aFile}->${bFile}`,
          kind,
          via,
          a,
          b,
          sentence
        })
        edges.push({
          id: `${kind}:${via}:${bFile}->${aFile}`,
          kind,
          via,
          a: b,
          b: a,
          sentence: connectionSentence({ kind, via, aTitle: b.title, bTitle: a.title })
        })
      }
    }
  }

  for (const person of input.people ?? []) {
    if (person.name?.trim()) addPairs('person', person.name.trim(), person.meetings ?? [])
  }
  for (const account of input.accounts ?? []) {
    if (account.name?.trim()) addPairs('account', account.name.trim(), account.meetings ?? [])
  }
  for (const deal of input.deals ?? []) {
    if (deal.name?.trim()) addPairs('deal', deal.name.trim(), deal.meetings ?? [])
  }

  const topicFiles = new Map<string, string[]>()
  for (const m of input.meetings ?? []) {
    const file = (m.source_file ?? '').trim()
    if (!file) continue
    for (const raw of m.topics ?? []) {
      const topic = raw.trim()
      if (!topic) continue
      const key = topic.toLowerCase()
      const list = topicFiles.get(key) ?? []
      if (!list.includes(file)) list.push(file)
      topicFiles.set(key, list)
      if (!titleByFile.has(file) && m.title24) titleByFile.set(file, m.title24)
    }
  }
  for (const [key, files] of topicFiles) {
    const display = (input.meetings ?? [])
      .flatMap((m) => m.topics ?? [])
      .find((t) => t.trim().toLowerCase() === key)
      ?.trim() || key
    addPairs(
      'topic',
      display,
      files.map((file) => ({ file, title: titleOf(file) }))
    )
  }

  return edges
}

/** One row per undirected pair+via for dashboard lists. Both meeting names stay clickable. */
export function uniqueConnectionPairs(edges: MeetingConnection[]): MeetingConnection[] {
  const seen = new Set<string>()
  const out: MeetingConnection[] = []
  for (const e of edges) {
    const files = [e.a.file, e.b.file].sort()
    const key = `${e.kind}|${e.via.toLowerCase()}|${files[0]}|${files[1]}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(e)
  }
  return out
}

export function connectionsForMeeting(edges: MeetingConnection[], file: string): MeetingConnection[] {
  return edges.filter((e) => e.a.file === file)
}

function uniqueFiles(refs: MeetingRefLike[]): string[] {
  const out: string[] = []
  for (const r of refs) {
    const f = (r.file ?? '').trim()
    if (f && !out.includes(f)) out.push(f)
  }
  return out
}

function uniqueSorted(items: string[]): string[] {
  return [...new Set(items)].sort((a, b) => a.localeCompare(b))
}

/** Path join that stays OS-agnostic for unit tests (no node:path in this module). */
function joinPath(...parts: string[]): string {
  const sep = parts.some((p) => p.includes('\\')) && !parts.some((p) => p.startsWith('/')) ? '\\' : '/'
  const cleaned = parts
    .filter((p) => p.length > 0)
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '')))
  return cleaned.join(sep)
}
