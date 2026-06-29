import { app } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, basename, delimiter } from 'node:path'
import { homedir } from 'node:os'
import { getSettings, getApiKey, hasApiKey } from './store'
import { resolveMeetingsFolder } from './transcripts'
import type { GraphStatus, GraphRelated } from '@shared/ipc'

const exec = promisify(execFile)

/**
 * Bridge to the external `graphify` knowledge-graph tool. AskToto spawns resources/graphify_runner.py
 * (with the interpreter that can import graphify) to turn the markdown notes folder into a graph
 * (graph.json + graph.html) under userData/graph. The graph is then surfaced in-app: "Open graph"
 * launches graph.html, and "Related notes" reads graph.json neighbours.
 *
 * Extraction reuses what the user already has — by default the local Claude Code CLI (`claude-cli`
 * backend, no API key), else their stored Claude/OpenAI key. No Gemini key required.
 */

// macOS/Linux GUI apps launch with a minimal PATH (no ~/.local/bin). Augment it so `graphify`, the
// resolved python, and `claude` (for the claude-cli backend) are findable in packaged builds too.
const IS_WIN = process.platform === 'win32'
/** `where` on Windows, `which` on macOS/Linux. */
const locateCmd = (): string => (IS_WIN ? 'where' : 'which')

const EXTRA_BINS = IS_WIN
  ? [
      join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Programs', 'Python'),
      join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'npm'),
      join(homedir(), '.local', 'bin')
    ]
  : [
      join(homedir(), '.local', 'bin'),
      join(homedir(), '.local', 'share', 'uv', 'tools', 'graphifyy', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin'
    ]
function augmentedPath(): string {
  const cur = (process.env.PATH || '').split(delimiter)
  const merged = [...cur, ...EXTRA_BINS.filter((p) => !cur.includes(p) && existsSync(p))]
  return merged.join(delimiter)
}
const spawnEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: augmentedPath(),
  ...extra
})

function runnerPath(): string {
  // Packaged: extraResources copies it next to process.resourcesPath. Dev: <projectRoot>/resources.
  const packaged = join(process.resourcesPath || '', 'graphify_runner.py')
  if (existsSync(packaged)) return packaged
  return join(app.getAppPath(), 'resources', 'graphify_runner.py')
}

function outDir(): string {
  return join(app.getPath('userData'), 'graph')
}
function graphJsonPath(): string {
  return join(outDir(), 'graph.json')
}
function graphHtmlPath(): string {
  return join(outDir(), 'graph.html')
}

// --- Python interpreter resolution (cached) -------------------------------------------------------

// Only a POSITIVE interpreter path is ever cached (never a null miss), so installing python/graphifyy
// after launch is picked up on the next probe instead of needing an app restart.
let cachedPython: string | undefined

async function canImport(py: string): Promise<boolean> {
  try {
    await exec(py, ['-c', 'import graphify'], { env: spawnEnv(), timeout: 15000 })
    return true
  } catch {
    return false
  }
}

async function detectPython(): Promise<string | null> {
  if (cachedPython !== undefined) return cachedPython
  // 1. (POSIX only) read the shebang of the `graphify` launcher — its interpreter has graphify.
  //    Windows uses a .exe shim with no shebang, so skip straight to interpreter probing there.
  if (!IS_WIN) {
    for (const probe of [
      () => exec('which', ['graphify'], { env: spawnEnv() }).then((r) => r.stdout.trim().split('\n')[0]),
      async () => {
        const direct = join(homedir(), '.local', 'bin', 'graphify')
        return existsSync(direct) ? direct : ''
      }
    ]) {
      try {
        const gbin = await probe()
        if (gbin && existsSync(gbin)) {
          const she = readFileSync(gbin, 'utf8').split('\n')[0].replace(/^#!\s*/, '').trim()
          if (she && /^[\w./-]+$/.test(she) && (await canImport(she))) return (cachedPython = she)
        }
      } catch {
        /* try next */
      }
    }
  }
  // 2. uv tool interpreter (cross-platform).
  try {
    const py = (
      await exec('uv', ['tool', 'run', 'graphifyy', 'python', '-c', 'import sys;print(sys.executable)'], {
        env: spawnEnv()
      })
    ).stdout.trim()
    if (py && (await canImport(py))) return (cachedPython = py)
  } catch {
    /* fall through */
  }
  // 3. Bare interpreters — Windows ships `python`/`py`, POSIX ships `python3`.
  for (const c of IS_WIN ? ['python', 'py', 'python3'] : ['python3', 'python']) {
    if (await canImport(c)) return (cachedPython = c)
  }
  return null // miss is NOT cached → a later call re-probes once the tool is installed
}

// --- Backend selection ("reuse Dust/Claude", never Gemini) ---------------------------------------

async function hasClaudeCli(): Promise<boolean> {
  const candidates = IS_WIN
    ? [
        join(process.env.LOCALAPPDATA || '', 'Programs', 'claude', 'claude.exe'),
        join(process.env.APPDATA || '', 'npm', 'claude.cmd')
      ]
    : [join(homedir(), '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']
  for (const p of candidates) {
    if (p && existsSync(p)) return true
  }
  try {
    await exec(locateCmd(), ['claude'], { env: spawnEnv() })
    return true
  } catch {
    return false
  }
}

/** Pick the extraction backend + (optional) API key. Prefers the local Claude Code CLI (no key). */
async function pickBackend(): Promise<{ backend: string; apiKey?: string } | null> {
  const s = getSettings()
  const pref = s.graphifyBackend
  if (pref === 'claude' && hasApiKey('anthropic')) return { backend: 'claude', apiKey: getApiKey('anthropic') }
  if (pref === 'openai' && hasApiKey('openai')) return { backend: 'openai', apiKey: getApiKey('openai') }
  // auto: local Claude Code → stored Claude key → stored OpenAI key
  if (await hasClaudeCli()) return { backend: 'claude-cli' }
  if (hasApiKey('anthropic')) return { backend: 'claude', apiKey: getApiKey('anthropic') }
  if (hasApiKey('openai')) return { backend: 'openai', apiKey: getApiKey('openai') }
  return null
}

// --- Status / build -------------------------------------------------------------------------------

let building = false
let lastError: string | null = null

export async function graphifyStatus(): Promise<GraphStatus> {
  const s = getSettings()
  const python = await detectPython()
  const backend = python ? await pickBackend() : null
  let lastBuiltAt: number | undefined
  let nodes: number | undefined
  let edges: number | undefined
  try {
    const gp = graphJsonPath()
    if (existsSync(gp)) {
      lastBuiltAt = statSync(gp).mtimeMs
      const g = JSON.parse(readFileSync(gp, 'utf8'))
      nodes = Array.isArray(g.nodes) ? g.nodes.length : undefined
      edges = Array.isArray(g.links) ? g.links.length : undefined
    }
  } catch {
    /* no graph yet */
  }
  return {
    enabled: s.graphifyEnabled,
    installed: !!python,
    backend: backend?.backend ?? null,
    building,
    hasGraph: existsSync(graphJsonPath()),
    lastBuiltAt,
    nodes,
    edges,
    error: lastError
  }
}

/** Build (or incrementally update) the notes graph. Returns the final status. */
export async function buildGraph(incremental = false): Promise<GraphStatus> {
  if (building) return graphifyStatus()
  // When at-rest encryption is on, the saved notes are ciphertext that graphify can't read — a manual
  // Rebuild would produce a garbage graph. scheduleRebuild() already skips for this reason; guard the
  // shared entrypoint too so the Rebuild button can't bypass it.
  if (getSettings().encryptTranscripts) {
    lastError = 'Knowledge graph is unavailable while at-rest encryption is on (your notes are encrypted on disk).'
    return graphifyStatus()
  }
  // Set the lock SYNCHRONOUSLY before any await — detectPython()/pickBackend() do child-process I/O
  // that yields to the event loop, so a second caller (rebuild double-click + the debounced timer)
  // could otherwise pass the `if (building)` check and spawn a concurrent build into the same outDir.
  building = true
  lastError = null
  try {
    const python = await detectPython()
    const picked = python ? await pickBackend() : null
    if (!python) {
      lastError = 'graphify is not installed. Run: pip install graphifyy (or: uv tool install graphifyy).'
    } else if (!picked) {
      lastError = 'No extraction backend. Install Claude Code, or add a Claude/OpenAI key in Settings → Your AI.'
    } else {
      const notes = resolveMeetingsFolder(getSettings())
      const args = ['build', '--input', notes, '--out', outDir(), '--backend', picked.backend]
      if (incremental) args.push('--incremental')
      const { stdout } = await exec(python, [runnerPath(), ...args], {
        env: spawnEnv(picked.apiKey ? { GRAPHIFY_API_KEY: picked.apiKey } : {}),
        timeout: 10 * 60_000,
        maxBuffer: 16 * 1024 * 1024
      })
      const line = stdout.trim().split('\n').filter(Boolean).pop() || '{}'
      const res = JSON.parse(line) as { ok: boolean; error?: string }
      if (!res.ok) lastError = res.error || 'Graph build failed.'
    }
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e)
  } finally {
    building = false
  }
  return graphifyStatus()
}

// --- Debounced auto-rebuild (after each saved note) ----------------------------------------------

let rebuildTimer: NodeJS.Timeout | null = null
const REBUILD_DEBOUNCE_MS = 20_000

/** Called after a note/meeting is saved. Coalesces a burst of saves into one incremental rebuild. */
export function scheduleRebuild(): void {
  const s = getSettings()
  // Encrypted transcripts are unreadable by the graphify runner — skip auto-rebuild in that mode.
  if (!s.graphifyEnabled || !s.graphifyAutoRebuild || s.encryptTranscripts) return
  if (rebuildTimer) clearTimeout(rebuildTimer)
  const fire = (): void => {
    rebuildTimer = null
    // A build is already running — retry shortly instead of dropping this note's update.
    if (building) {
      rebuildTimer = setTimeout(fire, 5_000)
      return
    }
    void buildGraph(true)
  }
  rebuildTimer = setTimeout(fire, REBUILD_DEBOUNCE_MS)
}

// --- Related notes (read graph.json neighbours) --------------------------------------------------

interface GNode {
  id: string
  label: string
  file_type?: string
  source_file?: string
}
interface GLink {
  source: string
  target: string
  relation?: string
}

/**
 * For a given note file, surface (a) its topics — concept nodes it contains plus concepts it links to —
 * and (b) related notes — other note files connected through those shared concepts (1- or 2-hop) or by a
 * direct edge. This is what makes the connections between notes legible inside AskToto.
 *
 * Pure over a parsed graph so it's unit-testable without Electron; `relatedNotes` wraps it with file IO.
 */
export function computeRelated(
  g: { nodes: GNode[]; links: GLink[] },
  noteFile: string
): GraphRelated {
  const base = basename(noteFile)
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  const sf = (n?: GNode): string => (n?.source_file ? basename(n.source_file) : '')
  const isNote = (n?: GNode): boolean => !!n && (n.file_type === 'document' || n.file_type === 'paper')
  const isConcept = (n?: GNode): boolean => !!n && !isNote(n)

  const mine = new Set(g.nodes.filter((n) => sf(n) === base).map((n) => n.id))
  if (mine.size === 0) return { ok: true, topics: [], notes: [] }

  const topicIds = new Set<string>()
  for (const id of mine) if (isConcept(byId.get(id))) topicIds.add(id) // concepts this note contains

  const related = new Map<string, { title: string; via: Set<string> }>()
  const addNote = (n: GNode | undefined, via?: string): void => {
    if (!isNote(n) || !n!.source_file || sf(n) === base) return
    const cur = related.get(n!.source_file) || { title: n!.label, via: new Set<string>() }
    if (via) cur.via.add(via)
    related.set(n!.source_file, cur)
  }

  // 1-hop from my nodes.
  const neighborConcepts = new Set<string>()
  for (const l of g.links) {
    const uMine = mine.has(l.source)
    const vMine = mine.has(l.target)
    if (uMine === vMine) continue
    const mineNode = byId.get(uMine ? l.source : l.target)
    const other = byId.get(uMine ? l.target : l.source)
    if (!other) continue
    if (isNote(other)) addNote(other, isConcept(mineNode) ? mineNode!.label : l.relation || 'related')
    else {
      neighborConcepts.add(other.id)
      topicIds.add(other.id)
    }
  }

  // 2-hop: other notes that also link to one of my neighbour concepts.
  for (const cId of neighborConcepts) {
    const topic = byId.get(cId)
    for (const l of g.links) {
      const otherId = l.source === cId ? l.target : l.target === cId ? l.source : null
      if (!otherId || mine.has(otherId)) continue
      addNote(byId.get(otherId), topic?.label)
    }
  }

  return {
    ok: true,
    topics: [...topicIds].map((id) => byId.get(id)?.label).filter((x): x is string => !!x).slice(0, 12),
    notes: [...related.entries()]
      .map(([file, r]) => ({ file: basename(file), title: r.title, via: [...r.via].slice(0, 3) }))
      .slice(0, 12)
  }
}

export function relatedNotes(noteFile: string): GraphRelated {
  const gp = graphJsonPath()
  if (!existsSync(gp)) return { ok: false, error: 'No graph yet — build it first.', topics: [], notes: [] }
  try {
    return computeRelated(JSON.parse(readFileSync(gp, 'utf8')), noteFile)
  } catch {
    return { ok: false, error: 'Graph file unreadable.', topics: [], notes: [] }
  }
}

export function graphHtml(): string | null {
  return existsSync(graphHtmlPath()) ? graphHtmlPath() : null
}
