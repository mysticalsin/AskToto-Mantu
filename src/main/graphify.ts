import { app } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, readdirSync, existsSync, statSync, rmSync } from 'node:fs'
import { join, basename, delimiter } from 'node:path'
import { homedir } from 'node:os'
import { getSettings, getApiKey, hasApiKey, getAllowedProviders } from './store'
import { resolveMeetingsFolder } from './transcripts'
import { readConfidentialMeetings } from './brain/publish'
import type { GraphStatus, GraphRelated, Settings } from '@shared/ipc'

const exec = promisify(execFile)

/**
 * Bridge to the external `graphify` knowledge-graph tool. Métis spawns resources/graphify_runner.py
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

/** The python.org per-user Windows installer never places python.exe directly in
 *  %LOCALAPPDATA%\Programs\Python — only in a version-numbered subfolder underneath it (e.g.
 *  ...\Python\Python312\python.exe). Returns that newest subfolder plus its Scripts dir (where
 *  pip-installed console scripts land), or [] if the base dir doesn't exist / has no version dirs. */
// exported for unit tests (graphify.test.ts) — the newest-version-dir selection is a pure function
export function windowsPythonDirs(): string[] {
  const base = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Programs', 'Python')
  try {
    const newest = readdirSync(base)
      .filter((d) => /^Python\d+$/i.test(d))
      .sort()
      .reverse()[0]
    if (!newest) return []
    const dir = join(base, newest)
    return [dir, join(dir, 'Scripts')]
  } catch {
    return []
  }
}

const EXTRA_BINS = IS_WIN
  ? [
      ...windowsPythonDirs(),
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
/** exec() options merger: always sets windowsHide (a console-subsystem child — `python`, `where`,
 *  `uv` — would otherwise flash a console window on Windows on every status poll/rebuild) alongside
 *  the PATH-augmented env from spawnEnv(). */
function execOpts<T extends Record<string, unknown>>(
  opts: T,
  envExtra: Record<string, string> = {}
): T & { env: NodeJS.ProcessEnv; windowsHide: true } {
  return { ...opts, env: spawnEnv(envExtra), windowsHide: true }
}

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
    await exec(py, ['-c', 'import graphify'], execOpts({ timeout: 15000 }))
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
      () => exec('which', ['graphify'], execOpts({})).then((r) => r.stdout.trim().split('\n')[0]),
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
  // 2. Existing uv tool interpreter (cross-platform). `uv tool run graphifyy ...` is intentionally
  // forbidden here: uv may provision the package on demand, which would mutate/download dependencies
  // after Métis is installed. `tool list --offline` is read-only and only exposes an environment that
  // the user already installed explicitly.
  try {
    const listed = await exec('uv', ['tool', 'list', '--show-paths', '--offline', '--no-config'], execOpts({}))
    const toolDir = listed.stdout.match(/^graphifyy\s+\S+\s+\((.+)\)\s*$/m)?.[1]
    const py = toolDir
      ? join(toolDir, IS_WIN ? 'Scripts' : 'bin', IS_WIN ? 'python.exe' : 'python')
      : ''
    if (py && existsSync(py) && (await canImport(py))) return (cachedPython = py)
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
    await exec(locateCmd(), ['claude'], execOpts({}))
    return true
  } catch {
    return false
  }
}

/** Pick the extraction backend + (optional) API key. Prefers the local Claude Code CLI (no key). */
async function pickBackend(): Promise<{ backend: string; apiKey?: string } | null> {
  const s = getSettings()
  const pref = s.graphifyBackend
  // Honor the org allowedProviders policy: graphify streams the full transcript to its backend, so a
  // pinned data-residency policy must gate the backend choice the same way the interactive ask path does.
  const allowed = getAllowedProviders()
  const ok = (pid: string): boolean => !allowed || allowed.includes(pid)
  if (pref === 'claude' && hasApiKey('anthropic') && ok('anthropic')) return { backend: 'claude', apiKey: getApiKey('anthropic') }
  if (pref === 'openai' && hasApiKey('openai') && ok('openai')) return { backend: 'openai', apiKey: getApiKey('openai') }
  // auto: local Claude Code → stored Claude key → stored OpenAI key
  if (ok('claude-cli') && (await hasClaudeCli())) return { backend: 'claude-cli' }
  if (hasApiKey('anthropic') && ok('anthropic')) return { backend: 'claude', apiKey: getApiKey('anthropic') }
  if (hasApiKey('openai') && ok('openai')) return { backend: 'openai', apiKey: getApiKey('openai') }
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

/**
 * Task MI-5 — whether graphify must refuse outright: transcripts are encrypted and there is no readable
 * plaintext substitute to point it at. When `publishBrainPages` is on, `graphifySourceDir` below routes
 * the build at the plaintext `wiki/` mirror instead (canonical, CRM-corrected names) and the build
 * proceeds normally — this is what removes the old encryption/graph deadlock. Pure so the routing
 * decision is unit-testable without invoking any child process (detectPython/pickBackend do real
 * subprocess I/O).
 */
export function graphifyRefusalReason(s: Settings): string | null {
  if (s.encryptTranscripts && !s.publishBrainPages) {
    return 'Knowledge graph is unavailable while at-rest encryption is on (your notes are encrypted on disk). Turn on "Publish meeting intelligence" in Settings to build it from the plaintext wiki mirror instead.'
  }
  return null
}

/** Task MI-5 — the directory graphify should scan: the plaintext `wiki/` mirror when transcripts are
 *  encrypted AND the user has explicitly consented to publish it (`publishBrainPages`), otherwise the
 *  meetings folder directly (unchanged pre-MI-5 behavior). Pure, same testability rationale as
 *  graphifyRefusalReason above. */
export function graphifySourceDir(s: Settings): string {
  // Prefer the plaintext wiki/ mirror whenever publishing is on: it is readable even under at-rest
  // encryption AND it excludes confidential meetings (the raw folder does neither). Fall back to the raw
  // meetings folder only when nothing is published — and confidentialGraphRefusal() blocks that fallback
  // whenever any meeting is confidential, so a confidential note is never fed into the graph. (QA #10)
  return s.publishBrainPages ? join(resolveMeetingsFolder(s), 'wiki') : resolveMeetingsFolder(s)
}

/** Non-pure companion to graphifyRefusalReason (it does file I/O, so it cannot live in that pure
 *  function): refuse to build when a confidential meeting would reach the graph. The published wiki/
 *  mirror excludes confidential meetings; the raw meetings folder does not. So whenever publishing is OFF
 *  (source = raw folder) and any meeting is flagged confidential, a build would extract that confidential
 *  content into the Dust-readable knowledge graph. Refuse until the user turns publishing on (which builds
 *  from the confidential-free mirror instead). (QA #10) */
function confidentialGraphRefusal(s: Settings): string | null {
  if (s.publishBrainPages) return null // source is the wiki mirror, which already excludes confidential
  if (readConfidentialMeetings(s).size === 0) return null
  return 'Some meetings are marked confidential, but the knowledge graph is built from your meetings folder, which still includes them. Turn on "Publish meeting intelligence" in Settings so the graph is built from the confidential-free published mirror instead.'
}

/** Build (or incrementally update) the notes graph. Returns the final status. */
export async function buildGraph(incremental = false): Promise<GraphStatus> {
  if (building) return graphifyStatus()
  // When at-rest encryption is on with no plaintext substitute available, the saved notes are ciphertext
  // that graphify can't read — a manual Rebuild would produce a garbage graph. scheduleRebuild() already
  // skips for this reason; guard the shared entrypoint too so the Rebuild button can't bypass it.
  const refusal = graphifyRefusalReason(getSettings())
  if (refusal) {
    lastError = refusal
    return graphifyStatus()
  }
  // Confidentiality fail-closed: never feed a confidential meeting into the graph (QA #10).
  const confidentialRefusal = confidentialGraphRefusal(getSettings())
  if (confidentialRefusal) {
    lastError = confidentialRefusal
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
      lastError = 'No extraction backend. Install Claude Code, or add a Claude/OpenAI key in Settings → AI.'
    } else {
      const notes = graphifySourceDir(getSettings())
      // Graph extraction is explicitly exempt from the CLI/Anthropic interactive guardrail (see
      // shared/providers.ts applyInteractiveGuardrail) — it's a bounded, infrequent background job where
      // extraction quality matters more than per-call cost, so it's allowed to reach for Opus. 'openai'
      // gets no override (no Anthropic Opus equivalent) — unchanged, whatever graphifyy's own default is.
      const modelArg =
        picked.backend === 'claude-cli' ? 'opus' : picked.backend === 'claude' ? 'claude-opus-4-8' : undefined
      const args = [
        'build', '--input', notes, '--out', outDir(), '--backend', picked.backend,
        ...(modelArg ? ['--model', modelArg] : [])
      ]
      if (incremental) args.push('--incremental')
      const { stdout } = await exec(
        python,
        [runnerPath(), ...args],
        execOpts(
          { timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 },
          picked.apiKey ? { GRAPHIFY_API_KEY: picked.apiKey } : {}
        )
      )
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
  if (!s.graphifyEnabled || !s.graphifyAutoRebuild) return
  // Encrypted transcripts are unreadable by the graphify runner UNLESS publishBrainPages routes the
  // build at the plaintext wiki/ mirror instead — see graphifyRefusalReason/graphifySourceDir above.
  if (graphifyRefusalReason(s)) return
  if (confidentialGraphRefusal(s)) return // don't auto-build a graph that would include a confidential meeting (QA #10)
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
 * direct edge. This is what makes the connections between notes legible inside Métis.
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
    const key = sf(n)
    const cur = related.get(key) || { title: n!.label, via: new Set<string>() }
    if (via) cur.via.add(via)
    related.set(key, cur)
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
      .map(([file, r]) => ({ file, title: r.title, via: [...r.via].slice(0, 3) }))
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

/**
 * Delete the plaintext graph artifacts (graph.json + graph.html) from userData/graph.
 *
 * Called when at-rest encryption is toggled ON. Once notes are encrypted on disk the graph can no
 * longer be (re)built, but a previously-built CLEARTEXT graph would otherwise linger on disk —
 * graph.json holds every meeting's topics/entities and graph.html renders them — leaking exactly the
 * meeting content the encryption is meant to protect. Best-effort: never throws (a failed unlink must
 * not crash the settings write that triggered it).
 */
export function purgeGraphArtifacts(): void {
  for (const p of [graphJsonPath(), graphHtmlPath()]) {
    try {
      if (existsSync(p)) rmSync(p, { force: true })
    } catch (e) {
      console.warn('[graphify] purgeGraphArtifacts: could not remove', p, e)
    }
  }
}
