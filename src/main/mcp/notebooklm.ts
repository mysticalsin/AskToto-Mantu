/**
 * notebooklm.ts — MCP client for NotebookLM research, backed by the community `notebooklm-mcp-cli`
 * (PyPI package `notebooklm-mcp-cli`; https://github.com/jacob-bd/notebooklm-mcp-cli).
 *
 * That CLI installs two executables:
 *   - `nlm`            — the CLI itself (install, login, doctor, ...)
 *   - `notebooklm-mcp` — the MCP server, **stdio transport by default** (its own docs list
 *     stdio/http/sse via `--transport`, defaulting to stdio). We deliberately only ever use stdio
 *     here: it spawns a local child process over stdin/stdout with no network socket at all, which
 *     is a strictly smaller attack surface than opening even a localhost HTTP port, and it matches
 *     the tool's own documented default — no reason to opt into the wider surface.
 *
 * Auth is NOT an API key: `nlm login` opens the user's own browser, they sign in to Google, and the
 * CLI extracts + stores session cookies itself (in its own `~/.notebooklm-mcp-cli` state, outside
 * Métis's control). This module never sees or stores a credential — it only detects whether the
 * CLI is present and classifies "not signed in" responses so Settings can prompt the user to
 * (re)connect their Google account. Every user-facing string says "Google account" plainly instead
 * of "credential"/"token" — there is nothing else to be honest about here.
 *
 * DEFENSIVE-CODING CONVENTIONS (mirrors bidstackClient.ts + main/cli.ts):
 *   - every exported function returns a typed { ok, ... } result — never throws into an unhandled
 *     rejection, never crashes the main process.
 *   - a hard timeout bounds every child-process/MCP round-trip via AbortController (connect) or a
 *     kill timer (install).
 *   - no shell:true, ever. Installs run through the user's login shell (mac/Linux, `-lc "<fixed
 *     command>"`) or cmd.exe-as-target-executable (Windows) — the same convention main/cli.ts uses
 *     for `npm i -g` — never a free-text string built from user input.
 *   - failures are classified into short, honest, non-technical messages. Raw stack traces / Python
 *     tracebacks never reach the renderer.
 */

import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createInterface } from 'node:readline'
import { mainLog } from '../logger'

const execFileAsync = promisify(execFile)

// ─── Timeouts ──────────────────────────────────────────────────────────────────
const DETECT_TIMEOUT_MS = 10_000
const CONNECT_TIMEOUT_MS = 20_000 // a cold Python/CLI start is slower than BidStack's HTTP connect
const ASK_TIMEOUT_MS = 60_000 // per the spec: askNotebookLm must resolve (or fail) within 60s
const INSTALL_TIMEOUT_MS = 180_000 // pip/uv/pipx installs are network-bound; give them real headroom

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// ─── Binary resolution (mirrors main/cli.ts's resolveBin; duplicated deliberately — this module must
// stand alone and cannot import from a file another workstream owns this wave). ─────────────────────
const binCache = new Map<string, string | null>()

function parseWhereOutput(stdout: string): string | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  // No fallback to lines[0]: an extension-less shadow PATH entry isn't launchable (mirrors
  // main/cli.ts's parseWhereOutput).
  return lines.find((l) => /\.(cmd|exe)$/i.test(l)) ?? null
}

/** Resolve a binary to its absolute path via the login shell (mac/Linux) or `where` (Windows). Only
 *  ever spawns the exact resolved absolute path afterwards — never a name influenced by user input. */
export async function resolveBinary(bin: string): Promise<string | null> {
  const cacheKey = bin
  if (binCache.has(cacheKey)) return binCache.get(cacheKey) ?? null

  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('where', [bin], { timeout: DETECT_TIMEOUT_MS, windowsHide: true })
      const resolved = parseWhereOutput(stdout)
      if (resolved) binCache.set(cacheKey, resolved)
      return resolved
    } catch {
      return null // not caching a miss — a subsequent in-app install must be picked up immediately
    }
  }

  const shell = process.env.SHELL || '/bin/zsh'
  try {
    const { stdout } = await execFileAsync(shell, ['-lc', `command -v ${bin}`], { timeout: DETECT_TIMEOUT_MS })
    const resolved = stdout.trim() || null
    if (resolved !== null) binCache.set(cacheKey, resolved)
    return resolved
  } catch {
    return null
  }
}

/** Evict a cached (positive or negative) lookup — call after an install so the next resolve re-probes. */
function evictBinaryCache(bin: string): void {
  binCache.delete(bin)
}

/** Test-only seam: binCache is process-lifetime state, so notebooklm.test.ts resets it between
 *  cases instead of relying on test ordering. Never called from production code. */
export function __resetBinaryCacheForTests(): void {
  binCache.clear()
}

// ─── Error classification — always a short, honest, non-technical message. Raw error text is used
// only to CHOOSE a category below; it is never echoed back to the caller. ──────────────────────────

interface Classified {
  message: string
  needsSignIn: boolean
}

const SIGN_IN_RE = /not[\s_-]?(logged|authenticated)|please (log|sign) ?in|reauthenticat|re-authenticat|cookie|401|unauthor/i
const NOT_FOUND_RE = /enoent|command not found|not recognized as an internal/i

function classifyConnectError(e: unknown): Classified {
  const raw = errMsg(e)
  const blob = raw.toLowerCase()
  if (blob.includes('abort')) {
    return { message: 'Timed out starting NotebookLM. Try again in a moment.', needsSignIn: false }
  }
  if (NOT_FOUND_RE.test(raw)) {
    return {
      message: 'The NotebookLM CLI is not installed. Set it up in Settings → Mantu Intelligence.',
      needsSignIn: false
    }
  }
  if (SIGN_IN_RE.test(raw)) {
    return {
      message: 'NotebookLM needs you to sign in with your Google account. Reconnect it in Settings → Mantu Intelligence.',
      needsSignIn: true
    }
  }
  return { message: 'Could not connect to NotebookLM. Make sure it is installed and try again.', needsSignIn: false }
}

function classifyAskError(e: unknown): Classified {
  const raw = errMsg(e)
  const blob = raw.toLowerCase()
  if (blob.includes('abort')) {
    return { message: 'NotebookLM took too long to answer. Try a shorter question or try again.', needsSignIn: false }
  }
  if (NOT_FOUND_RE.test(raw)) {
    return {
      message: 'The NotebookLM CLI is not installed. Set it up in Settings → Mantu Intelligence.',
      needsSignIn: false
    }
  }
  if (SIGN_IN_RE.test(raw)) {
    return {
      message: 'NotebookLM needs you to sign in with your Google account again. Reconnect it in Settings → Mantu Intelligence.',
      needsSignIn: true
    }
  }
  return { message: 'NotebookLM could not answer that just now. Try again in a moment.', needsSignIn: false }
}

// ─── Stdio MCP plumbing (mirrors bidstackClient.ts's withClient, stdio instead of Streamable HTTP) ──

/** Request options handed to every call `fn` makes — both a local AbortController (fires once, bounds
 *  connect + the call together) and an explicit `timeout` (so the call is bounded by OUR timeoutMs
 *  rather than quietly relying on the SDK's own DEFAULT_REQUEST_TIMEOUT_MSEC coinciding with it). */
export interface StdioRequestOpts {
  signal: AbortSignal
  timeout: number
}

async function withStdioClient<T>(
  command: string,
  timeoutMs: number,
  fn: (client: Client, opts: StdioRequestOpts) => Promise<T>
): Promise<T> {
  // MCP SDK statically imported (NOT `await import()`): the main process is bytecode-compiled and dynamic
  // import throws "A dynamic import callback was not specified" under bytecode, which broke every
  // NotebookLM action. The SDK ships a CJS build (dist/cjs), so the static import is bytecode-safe.
  const client = new Client({ name: 'asktoto', version: '1.0.0' }, { capabilities: {} })
  // Fresh client + transport (= fresh spawned process) per call — never reused across calls, same
  // policy as bidstackClient.ts. `stderr: 'pipe'` so a crash's stderr never leaks to Métis's own
  // stderr/console; we only use it (via the caught error) to classify the failure.
  const transport = new StdioClientTransport({ command, args: [], stderr: 'pipe' })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const opts: StdioRequestOpts = { signal: controller.signal, timeout: timeoutMs }
  try {
    await client.connect(transport, { signal: controller.signal })
    return await fn(client, opts)
  } finally {
    clearTimeout(timer)
    try {
      await client.close()
    } catch {
      /* best-effort teardown — a close failure must never mask the real result/error */
    }
  }
}

// ─── detectNotebookLmCli ─────────────────────────────────────────────────────────

export interface NotebookLmDetectResult {
  ok: boolean
  version?: string
  error?: string
}

/** Check whether the `nlm` CLI is installed. Does not check Google sign-in — use connectNotebookLm
 *  for that (its result's `needsSignIn` flag distinguishes "not installed" from "installed, not
 *  signed in"). Mirrors detectCli() in main/cli.ts. */
export async function detectNotebookLmCli(): Promise<NotebookLmDetectResult> {
  const bin = await resolveBinary('nlm')
  if (!bin) return { ok: false, error: 'NotebookLM CLI is not installed.' }
  try {
    const { stdout } = await execFileAsync(bin, ['--version'], { timeout: DETECT_TIMEOUT_MS, windowsHide: true })
    return { ok: true, version: stdout.trim().slice(0, 40) || 'installed' }
  } catch {
    // --version failing doesn't mean the binary is missing — we already resolved it above.
    return { ok: true, version: 'installed' }
  }
}

// ─── installNotebookLmCli ─────────────────────────────────────────────────────────

export interface NotebookLmInstallResult {
  ok: boolean
  error?: string
  needsTerminal?: boolean
}

/** Matches a permission failure (mac/Linux EACCES, Windows EPERM) or Python's PEP 668
 *  "externally managed environment" refusal — either way the caller should be pointed at installing
 *  `uv` (which never hits either problem) rather than retried automatically. */
const INSTALL_BLOCKED_RE = /EACCES|EPERM|permission denied|not permitted|externally[- ]managed[- ]environment/i

interface PkgManager {
  bin: string
  buildArgs: (win: boolean) => string[]
}

/** Single-quote a value for a POSIX login-shell command string (mac/Linux install path below). The
 *  resolved package-manager path could theoretically contain a space (e.g. under "Application
 *  Support"); every value here is either a resolved absolute path or a fixed constant, never
 *  user-typed text, but this keeps the built command correct regardless. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// Preference order: uv (recommended by the project, isolates its own venv, never hits PEP 668) →
// pipx (also isolates) → pip (last resort; can fail with "externally managed environment" on modern
// Python installs, classified above into a friendly message rather than a raw pip error dump).
const PKG_MANAGERS: PkgManager[] = [
  { bin: 'uv', buildArgs: () => ['tool', 'install', 'notebooklm-mcp-cli'] },
  { bin: 'pipx', buildArgs: () => ['install', 'notebooklm-mcp-cli'] },
  { bin: 'pip3', buildArgs: () => ['install', '--user', 'notebooklm-mcp-cli'] },
  { bin: 'pip', buildArgs: () => ['install', '--user', 'notebooklm-mcp-cli'] }
]

/**
 * Install notebooklm-mcp-cli via the first available of uv / pipx / pip3 / pip. Streams progress
 * lines to onProgress. Never uses shell:true; the install command is a fixed, hardcoded argv per
 * package manager — no user input is ever interpolated into it.
 */
export async function installNotebookLmCli(onProgress: (line: string) => void): Promise<NotebookLmInstallResult> {
  const already = await resolveBinary('nlm')
  if (already) {
    onProgress('Already installed.')
    return { ok: true }
  }

  let manager: PkgManager | null = null
  let managerBin: string | null = null
  for (const candidate of PKG_MANAGERS) {
    const resolved = await resolveBinary(candidate.bin)
    if (resolved) {
      manager = candidate
      managerBin = resolved
      break
    }
  }
  if (!manager || !managerBin) {
    return {
      ok: false,
      error: 'Métis could not set up NotebookLM automatically on this computer. Your IT team can enable it, or try again later.'
    }
  }

  const isWin = process.platform === 'win32'
  const args = manager.buildArgs(isWin)

  return new Promise<NotebookLmInstallResult>((resolve) => {
    let settled = false
    const finish = (r: NotebookLmInstallResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }

    const child = isWin
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', managerBin!, ...args], {
          env: process.env,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        })
      : spawn(process.env.SHELL || '/bin/zsh', ['-lc', [managerBin, ...args].map(shQuote).join(' ')], {
          env: process.env,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe']
        })

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish({ ok: false, error: 'Install timed out. Check your network connection and try again.' })
    }, INSTALL_TIMEOUT_MS)

    const stderrLines: string[] = []

    const stdoutRl = createInterface({ input: child.stdout!, crlfDelay: Infinity })
    stdoutRl.on('line', (line) => {
      const trimmed = line.trim()
      if (trimmed) onProgress(trimmed)
    })

    const stderrRl = createInterface({ input: child.stderr!, crlfDelay: Infinity })
    stderrRl.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      stderrLines.push(trimmed)
      onProgress(trimmed)
    })

    child.on('error', (err) => {
      mainLog.warn('[notebooklm] install spawn failed', errMsg(err))
      finish({ ok: false, error: 'Could not start the installer. Check your network connection and try again.' })
    })

    child.on('close', (code) => {
      if (settled) return
      if (code === 0) {
        evictBinaryCache('nlm')
        evictBinaryCache('notebooklm-mcp')
        finish({ ok: true })
        return
      }
      const stderrText = stderrLines.join('\n')
      if (INSTALL_BLOCKED_RE.test(stderrText)) {
        finish({
          ok: false,
          needsTerminal: true,
          error: 'Métis does not have permission to finish setting up NotebookLM on this computer. Your IT team can help, or try again later.'
        })
        return
      }
      finish({ ok: false, error: `Install failed (exit ${code}). Check your network connection and try again.` })
    })
  })
}

// ─── connectNotebookLm ─────────────────────────────────────────────────────────

export interface NotebookLmConnectResult {
  ok: boolean
  error?: string
  tools?: string[]
  /** True when the failure is specifically "not signed in" — Settings should show the Google
   *  sign-in prompt rather than a generic connection error. */
  needsSignIn?: boolean
}

// Concurrent connect calls (e.g. Settings "Test connection" firing twice) share one spawned process
// and one log line instead of each spawning its own `notebooklm-mcp`. Mirrors bidstackClient.ts.
let inFlightConnect: Promise<NotebookLmConnectResult> | null = null

async function connectNotebookLmNow(): Promise<NotebookLmConnectResult> {
  const bin = await resolveBinary('notebooklm-mcp')
  if (!bin) {
    return { ok: false, error: 'NotebookLM CLI is not installed. Set it up in Settings → Mantu Intelligence.' }
  }
  try {
    const tools = await withStdioClient(bin, CONNECT_TIMEOUT_MS, async (client, opts) => {
      const res = await client.listTools(undefined, opts)
      return res.tools.map((t) => t.name)
    })
    return { ok: true, tools }
  } catch (e) {
    mainLog.warn('[notebooklm] connect failed', errMsg(e))
    const c = classifyConnectError(e)
    return { ok: false, error: c.message, needsSignIn: c.needsSignIn }
  }
}

/**
 * Start (or attach to) the local NotebookLM MCP server over stdio, list its declared tools, and
 * report whether the user still needs to sign in with Google. Never throws.
 */
export async function connectNotebookLm(): Promise<NotebookLmConnectResult> {
  if (inFlightConnect) return inFlightConnect
  const attempt = connectNotebookLmNow().finally(() => {
    inFlightConnect = null
  })
  inFlightConnect = attempt
  return attempt
}

// ─── askNotebookLm ─────────────────────────────────────────────────────────────

const QUESTION_MAX_LEN = 4_000
const NOTEBOOK_ID_MAX_LEN = 200

export interface AskNotebookLmInput {
  question: string
  /** Restrict the answer to one notebook. Omit to research across every notebook the user has. */
  notebookId?: string
}

export interface NotebookLmAskResult {
  ok: boolean
  error?: string
  text?: string
  needsSignIn?: boolean
}

/** Pull every text part out of an MCP tool result's content array into one string. Content shape is
 *  the standard MCP `{ type: 'text', text: string }[]` — this makes no assumption beyond that about
 *  NotebookLM's specific tool schemas (undocumented internal APIs per its own README). */
function extractText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> } | undefined)?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n')
    .trim()
}

/**
 * Ask NotebookLM a research question, optionally scoped to one notebook. With no notebookId, queries
 * across every notebook the signed-in Google account has (cross_notebook_query). Bounded to 60s so
 * it is safe to call live during a meeting as well as afterward. Never throws.
 */
export async function askNotebookLm(input: AskNotebookLmInput): Promise<NotebookLmAskResult> {
  const question = (input?.question ?? '').trim()
  if (!question) return { ok: false, error: 'Enter a question for NotebookLM first.' }
  if (question.length > QUESTION_MAX_LEN) {
    return { ok: false, error: `That question is too long (max ${QUESTION_MAX_LEN} characters).` }
  }
  const notebookId = (input?.notebookId ?? '').trim().slice(0, NOTEBOOK_ID_MAX_LEN) || undefined

  const bin = await resolveBinary('notebooklm-mcp')
  if (!bin) {
    return { ok: false, error: 'NotebookLM CLI is not installed. Set it up in Settings → Mantu Intelligence.' }
  }

  const toolName = notebookId ? 'notebook_query' : 'cross_notebook_query'
  const args = notebookId ? { notebook_id: notebookId, query: question } : { query: question, all: true }

  try {
    const result = await withStdioClient(bin, ASK_TIMEOUT_MS, (client, opts) =>
      client.callTool({ name: toolName, arguments: args }, undefined, opts)
    )
    if (result && typeof result === 'object' && (result as { isError?: boolean }).isError) {
      const c = classifyAskError(new Error(extractText(result) || 'tool reported an error'))
      return { ok: false, error: c.message, needsSignIn: c.needsSignIn }
    }
    const text = extractText(result)
    if (!text) return { ok: false, error: 'NotebookLM did not return an answer. Try rephrasing the question.' }
    return { ok: true, text }
  } catch (e) {
    mainLog.warn('[notebooklm] ask failed', errMsg(e))
    const c = classifyAskError(e)
    return { ok: false, error: c.message, needsSignIn: c.needsSignIn }
  }
}
