/**
 * CLI provider backend — claude-cli (Claude Code) and codex-cli (OpenAI Codex).
 *
 * SECURITY INVARIANTS (never relax):
 *   - No shell:true. All spawns pass args as an array. On Windows, a `.cmd` npm shim is launched via
 *     cmd.exe as the *target executable* (see resolveSpawnTarget) — that is not shell:true, and any
 *     arg containing a quote, newline, or a cmd.exe command-separator/expansion metacharacter
 *     (&|^%<>()!) is rejected first (see cmdShimSpawn).
 *   - claude-cli: --allowedTools '' --disallowedTools '*' so the agent can never execute arbitrary tools.
 *   - codex-cli: features.shell_tool=false + runs in a throwaway tmp cwd.
 *   - resolveBin() finds the absolute path via the login shell (mac/Linux) or `where` + an APPDATA
 *     probe (Windows) — never relies on a minimal GUI PATH.
 */

import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { app, shell } from 'electron'
import { existsSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import type { ProviderId } from '@shared/providers'
import { PROVIDERS } from '@shared/providers'
import type { CliActionResult, CliInstallResult } from '@shared/ipc'

const execFileAsync = promisify(execFile)

// ─── Idle watchdog (mirrors llm.ts) ────────────────────────────────────────────
const STREAM_IDLE_MS = 120_000
// exported for unit tests (cli.test.ts) — security/reliability-critical, must stay covered
export function idleWatchdog(
  onIdle: () => void,
  idleMs: number = STREAM_IDLE_MS
): { ping: () => void; clear: () => void } {
  let t: NodeJS.Timeout | null = setTimeout(onIdle, idleMs)
  return {
    ping: () => {
      if (t) clearTimeout(t)
      t = setTimeout(onIdle, idleMs)
    },
    clear: () => {
      if (t) {
        clearTimeout(t)
        t = null
      }
    }
  }
}

// ─── Binary resolution: login shell (mac/Linux) or `where` + npm global probe (Windows) ────────
const binCache = new Map<string, string | null>()

/** Parse `where <bin>` stdout: return the first hit ending in .cmd or .exe. `where` can list several
 *  shadowed matches (e.g. an extension-less dir entry) — only a .cmd shim or .exe is launchable. */
export function parseWhereOutput(stdout: string): string | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  return lines.find((l) => /\.(cmd|exe)$/i.test(l)) ?? null
}

/** npm's default global-bin locations on Windows for a given binary name. Used as a fallback when
 *  `where` misses right after a fresh in-app `npm i -g`: a GUI process (Electron launched from Explorer
 *  or a shortcut) holds a PATH snapshot that does not pick up a PATH change npm may have written to the
 *  registry mid-session, so `where` can legitimately miss a binary that was just installed. */
export function npmGlobalBinCandidates(bin: string): string[] {
  const appData = process.env.APPDATA ?? ''
  if (!appData) return []
  return [join(appData, 'npm', `${bin}.cmd`), join(appData, 'npm', `${bin}.exe`)]
}

/**
 * Resolve a CLI binary to its absolute path.
 * A packaged Electron app runs with a minimal PATH. On macOS/Linux the login shell loads the full
 * environment (nvm, homebrew, user profile, etc.) so `claude` / `codex` installed globally are found.
 * On Windows there is no login-shell equivalent, so we shell out to `where`, then fall back to probing
 * npm's default global-bin folder directly (see npmGlobalBinCandidates) for the stale-PATH case above.
 * Results are cached in-process — resolveBin is called on every streaming request, so caching
 * prevents repeated shell spawns per conversation turn.
 */
export async function resolveBin(bin: string): Promise<string | null> {
  if (binCache.has(bin)) return binCache.get(bin) ?? null

  if (process.platform === 'win32') {
    try {
      // windowsHide: `where` is a console-subsystem binary — without this a child console window
      // flashes on screen even though nothing is printed to it.
      const { stdout } = await execFileAsync('where', [bin], { windowsHide: true })
      const resolved = parseWhereOutput(stdout)
      if (resolved) {
        binCache.set(bin, resolved)
        return resolved
      }
    } catch {
      // `where` exits non-zero when nothing on PATH matches — fall through to the APPDATA probe.
    }
    for (const candidate of npmGlobalBinCandidates(bin)) {
      if (existsSync(candidate)) {
        binCache.set(bin, candidate)
        return candidate
      }
    }
    // Not caching the miss mirrors the mac/Linux branch below — a subsequent in-app install must be
    // picked up immediately without requiring an app restart.
    return null
  }

  const shell = process.env.SHELL || '/bin/zsh'
  try {
    const { stdout } = await execFileAsync(shell, ['-lc', `command -v ${bin}`])
    const resolved = stdout.trim() || null
    // Only cache positive hits; null (not-found) must not be cached so that a subsequent
    // in-app install is picked up immediately without requiring an app restart.
    if (resolved !== null) binCache.set(bin, resolved)
    return resolved
  } catch {
    return null
  }
}

/** Env for spawning a CLI. For claude-cli, strip Claude-Code session + proxy vars so the spawned
 *  `claude` runs as a clean standalone invocation against the user's own keychain login (avoids a
 *  hang when Métis is itself launched from a Claude Code session, and ignores a proxy base URL).
 *  Also strips ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN so the spawned `claude -p` uses the
 *  interactive CLI login (honours the "no key required" contract) and not silent API-key billing. */
export function cliEnv(provider: ProviderId): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (provider === 'claude-cli') {
    for (const k of Object.keys(env)) {
      if (/^CLAUDE_CODE/i.test(k) || k === 'CLAUDECODE' || k === 'CLAUDE_AGENT_SDK_VERSION' || k === 'CLAUDE_TMPDIR') {
        delete env[k]
      }
    }
    delete env.ANTHROPIC_BASE_URL
    // Remove API-key vars so `claude -p` auths via the user's CLI login, not API-key billing.
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
  } else if (provider === 'codex-cli') {
    delete env.OPENAI_BASE_URL
  }
  return env
}

// ─── Windows .cmd shim spawn ─────────────────────────────────────────────────────
// npm's global installer puts a `<bin>.cmd` batch-file shim on Windows (it wraps the real JS entry
// point). `resolveBin` can therefore return a `.cmd` path there instead of a `.exe`.

/** True when the resolved binary is a Windows npm shim (`<bin>.cmd`), which cannot be spawned directly. */
export function isCmdShim(bin: string): boolean {
  return /\.cmd$/i.test(bin)
}

/**
 * Build the { command, args } to launch a `.cmd` shim via cmd.exe. Node/Electron builds patched for
 * CVE-2024-27980 throw EINVAL when spawn() is given a `.cmd`/`.bat` target directly with shell:false —
 * on Windows, batch files can only be launched through cmd.exe's own argument parser, never execve'd.
 * `/d` skips AutoRun scripts, `/s` keeps the quoting of the rest of the command line intact, `/c` runs
 * it and exits.
 *
 * SECURITY: this does NOT reopen the "no shell:true" invariant declared at the top of this file — the
 * spawn() call at each site still passes shell:false; cmd.exe here is only the *target executable*,
 * not a shell re-interpreting a joined string. But cmd.exe's own argv parsing (unlike execve) treats
 * '"', newlines, and its own command-separator/escape/redirection metacharacters (& | ^ % < > ( ) !)
 * specially, so any arg containing one of those is rejected before the argv array is built. Node's
 * libuv only quotes an argv element when it contains whitespace or a quote, so a metacharacter with no
 * surrounding space would otherwise reach cmd.exe completely unquoted. Not every arg that reaches this
 * function is a fixed constant: the model id can be free text a user typed into Settings (codex-cli has
 * no fixed model list, and the brain-ingest path can deliver a model string without going through the
 * interactive guardrail) — free-text prompt/system content always goes via stdin, never argv, but the
 * model id does not, which is exactly why this backstop exists.
 */
export function cmdShimSpawn(bin: string, args: string[]): { command: string; args: string[] } {
  for (const a of [bin, ...args]) {
    if (/["\r\n&|^%<>()!]/.test(a)) {
      throw new Error(
        'refusing to spawn: an argument contains a quote, newline, or cmd.exe metacharacter (unsafe for cmd.exe)'
      )
    }
  }
  return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', bin, ...args] }
}

/** Resolve the actual { command, args } to spawn for a CLI binary: direct on macOS/Linux and for
 *  Windows .exe binaries; routed through cmd.exe for Windows .cmd shims (see cmdShimSpawn above). */
export function resolveSpawnTarget(bin: string, args: string[]): { command: string; args: string[] } {
  return isCmdShim(bin) ? cmdShimSpawn(bin, args) : { command: bin, args }
}

// ─── Per-provider CLI config ─────────────────────────────────────────────────────

interface CliConfig {
  bin: string
  // Builds the argv list. Prompt and system content are delivered via stdin, never as argv
  // args — prevents transcript/system text from appearing in `ps -ww` / /proc/<pid>/cmdline.
  buildArgs(opts: { model: string }): string[]
  parseLine(line: string): string | null
  /** codex runs in a throwaway temp cwd so it never touches the user's project. */
  useTmpCwd: boolean
}

// exported for unit tests (cli.test.ts) — the locked-down arg arrays are a security invariant
export const CLI_CONFIGS: Partial<Record<ProviderId, CliConfig>> = {
  'claude-cli': {
    bin: 'claude',
    buildArgs({ model }) {
      // '-p' with no positional arg puts claude in print/non-interactive mode reading from stdin.
      // system + prompt are written to child.stdin after spawn — never exposed in argv.
      return [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--max-turns',
        '1',
        '--allowedTools',
        '',
        '--disallowedTools',
        '*',
        ...(model ? ['--model', model] : [])
      ]
    },
    parseLine(line) {
      try {
        const obj = JSON.parse(line)
        if (
          obj.type === 'stream_event' &&
          obj.event?.delta?.type === 'text_delta'
        ) {
          return typeof obj.event.delta.text === 'string' ? obj.event.delta.text : null
        }
        return null
      } catch {
        return null
      }
    },
    useTmpCwd: false
  },

  'codex-cli': {
    bin: 'codex',
    buildArgs({ model }) {
      // 'exec' with no positional arg reads the prompt from stdin.
      // system + prompt are written to child.stdin after spawn — never exposed in argv.
      return [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '-c',
        'features.shell_tool=false',
        ...(model ? ['-m', model] : [])
      ]
    },
    parseLine(line) {
      try {
        const obj = JSON.parse(line)
        if (obj.type === 'item.completed' && obj.item?.type === 'agent_message') {
          return typeof obj.item.text === 'string' ? obj.item.text : null
        }
        return null
      } catch {
        return null
      }
    },
    useTmpCwd: true
  }
}

// ─── runCliStream ────────────────────────────────────────────────────────────────

export interface RunCliStreamOpts {
  providerId: ProviderId
  model: string
  system: string
  prompt: string
  /** Idle watchdog budget in ms (per-tier: live suggest ~15s, recap/deep 120s). Defaults to 120s. */
  idleMs?: number
  handlers: {
    onDelta: (text: string) => void
    onDone: (u: Record<string, never>) => void
    onError: (message: string) => void
  }
}

/**
 * Spawn the CLI binary and stream its output to handlers.
 * Returns { abort } immediately; the stream runs asynchronously.
 */
export function runCliStream(opts: RunCliStreamOpts): { abort: () => void } {
  const cfg = CLI_CONFIGS[opts.providerId]
  const label = PROVIDERS[opts.providerId]?.label ?? opts.providerId

  const controller = new AbortController()
  let settled = false
  let tmpCwd: string | undefined

  let wd: { ping: () => void; clear: () => void }
  const fail = (msg: string): void => {
    if (settled || controller.signal.aborted) return
    settled = true
    wd?.clear()
    opts.handlers.onError(msg)
  }
  // Per-tier idle budget from the caller (a live suggest gives up in seconds so failover can fire;
  // recaps get full headroom) — a hung CLI must not block the real-time path for the full 120s.
  const idleMs = opts.idleMs ?? STREAM_IDLE_MS
  wd = idleWatchdog(() => {
    fail(`${label}: stream timed out — no output for ${Math.round(idleMs / 1000)}s.`)
    controller.abort()
  }, idleMs)

  void (async () => {
    if (!cfg) {
      return fail(`${label}: unsupported CLI provider '${opts.providerId}'.`)
    }

    const absBin = await resolveBin(cfg.bin)
    if (!absBin) {
      wd.clear()
      return fail(`${label} CLI not found. Set it up in Settings → CLI Integration.`)
    }

    // codex needs a throwaway working directory so it never mutates the user's project.
    let cwd: string | undefined
    if (cfg.useTmpCwd) {
      try {
        tmpCwd = await mkdtemp(join(tmpdir(), 'asktoto-cli-'))
        cwd = tmpCwd
      } catch {
        fail(`${label}: could not create a sandbox working directory.`)
        return
      }
    }

    const args = cfg.buildArgs({ model: opts.model })
    let spawnTarget: { command: string; args: string[] }
    try {
      // Windows .cmd shims must go through cmd.exe (see resolveSpawnTarget); everything else spawns
      // directly, byte-identical to before.
      spawnTarget = resolveSpawnTarget(absBin, args)
    } catch (e) {
      wd.clear()
      return fail(`${label}: ${e instanceof Error ? e.message : 'refusing unsafe spawn arguments'}`)
    }
    const child = spawn(spawnTarget.command, spawnTarget.args, {
      cwd,
      signal: controller.signal,
      env: cliEnv(opts.providerId),
      // SECURITY: never use shell:true — args are passed as an array. On Windows, cmd.exe may be the
      // spawn target for a .cmd shim (see resolveSpawnTarget) but it is never invoked as a shell here.
      shell: false,
      // Every 'Ask' spawns this — without windowsHide a console window flashes on top of the
      // always-on-top overlay (and anything the user is screen-sharing) on every single call.
      windowsHide: true,
      // 'pipe' for stdin so we can write prompt + system without exposing them in argv
      stdio: ['pipe', 'pipe', 'pipe']
    })

    // Write content to stdin — keeps transcript and system text out of argv (ps -ww / /proc).
    // System text (if any) is prepended so the CLI sees it before the user prompt.
    // EPIPE/ECONNRESET when the child exits before draining stdin is delivered ASYNCHRONOUSLY
    // on the stdin Writable, so the sync try/catch below can't catch it — without this listener
    // it escapes to process 'uncaughtException' and pops a false crash dialog. The child's own
    // 'close'/'error' handlers report the real outcome.
    child.stdin!.on('error', () => {})
    try {
      const stdinContent = [opts.system, opts.prompt].filter(Boolean).join('\n\n')
      child.stdin!.write(stdinContent, 'utf8')
      child.stdin!.end()
    } catch {
      // stdin already closed (child exited immediately) — 'error'/'close' events handle it
    }

    const stderrChunks: Buffer[] = []
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity })
    rl.on('line', (line) => {
      if (!line.trim()) return
      try {
        const text = cfg.parseLine(line)
        if (text !== null) {
          wd.ping()
          opts.handlers.onDelta(text)
        }
      } catch {
        // Non-JSON lines (e.g. status messages) are silently ignored
      }
    })

    child.on('error', (err) => {
      if (controller.signal.aborted) return
      fail(`${label}: spawn error — ${err.message}`)
    })

    child.on('close', (code) => {
      rl.close()
      void cleanup()
      if (settled || controller.signal.aborted) return
      if (code === 0) {
        settled = true
        wd.clear()
        opts.handlers.onDone({})
      } else {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim()
        fail(stderr.slice(-500) || `${label}: exited with code ${code}`)
      }
    })
  })()

  async function cleanup(): Promise<void> {
    if (tmpCwd) {
      try {
        await rm(tmpCwd, { recursive: true, force: true })
      } catch {
        /* best-effort cleanup */
      }
      tmpCwd = undefined
    }
  }

  return {
    abort: () => {
      wd.clear()
      controller.abort()
    }
  }
}

// ─── detectCli ───────────────────────────────────────────────────────────────────

/**
 * Check whether the CLI binary is installed and return its version string.
 * Does NOT test authentication (use testCli for that).
 */
export async function detectCli(provider: ProviderId): Promise<CliActionResult> {
  const cfg = CLI_CONFIGS[provider]
  const label = PROVIDERS[provider]?.label ?? provider
  if (!cfg) return { ok: false, error: `${label}: unsupported CLI provider.` }

  const absBin = await resolveBin(cfg.bin)
  if (!absBin) return { ok: false, error: `${label} not installed` }

  try {
    // Windows .cmd shims must go through cmd.exe (see resolveSpawnTarget) — the same EINVAL landmine
    // as the spawn() call sites below, just reached via execFile here instead.
    const spawnTarget = resolveSpawnTarget(absBin, ['--version'])
    const { stdout } = await execFileAsync(spawnTarget.command, spawnTarget.args, { windowsHide: true })
    return { ok: true, version: stdout.trim().slice(0, 40) }
  } catch {
    // --version might fail on some builds; binary is present but couldn't run
    return { ok: true, version: 'installed' }
  }
}

// ─── testCli ─────────────────────────────────────────────────────────────────────

const TEST_TIMEOUT_MS = 45_000

/**
 * Prove that the CLI is installed AND authenticated by running a tiny prompt.
 * Returns { ok: true } iff the process exits 0 with non-empty stdout within 30 s.
 */
export async function testCli(provider: ProviderId): Promise<CliActionResult> {
  const cfg = CLI_CONFIGS[provider]
  const label = PROVIDERS[provider]?.label ?? provider
  if (!cfg) return { ok: false, error: `${label}: unsupported CLI provider.` }

  const absBin = await resolveBin(cfg.bin)
  if (!absBin) return { ok: false, error: `${label} not installed` }

  let testArgs: string[]
  let testCwd: string | undefined
  let tmpDir: string | undefined

  if (provider === 'claude-cli') {
    // '-p' with no positional arg reads the prompt from stdin (consistent with runCliStream).
    testArgs = ['-p', '--output-format', 'text', '--max-turns', '1', '--allowedTools', '']
  } else {
    // codex-cli: needs a throwaway cwd
    try {
      tmpDir = await mkdtemp(join(tmpdir(), 'asktoto-clitest-'))
      testCwd = tmpDir
    } catch {
      /* proceed without a dedicated cwd */
    }
    // 'exec' with no positional arg reads the prompt from stdin (consistent with runCliStream).
    testArgs = ['exec', '--skip-git-repo-check', '-c', 'features.shell_tool=false']
  }

  let spawnTarget: { command: string; args: string[] }
  try {
    // Windows .cmd shims must go through cmd.exe (see resolveSpawnTarget); everything else spawns
    // directly, byte-identical to before.
    spawnTarget = resolveSpawnTarget(absBin, testArgs)
  } catch (e) {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    return { ok: false, error: e instanceof Error ? e.message : 'refusing unsafe spawn arguments' }
  }

  return new Promise<CliActionResult>((resolve) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      if (tmpDir) rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      resolve({ ok: false, error: 'Timed out after 45 s — are you logged in?' })
    }, TEST_TIMEOUT_MS)

    const child = spawn(spawnTarget.command, spawnTarget.args, {
      cwd: testCwd,
      env: cliEnv(provider),
      // SECURITY: never use shell:true. cmd.exe may be the spawn target for a Windows .cmd shim (see
      // resolveSpawnTarget) but it is never invoked as a shell here.
      shell: false,
      // Runs on every Connect/Test-connection click — without this a console window flashes.
      windowsHide: true,
      // 'pipe' for stdin so we write the test prompt without it appearing in argv
      stdio: ['pipe', 'pipe', 'pipe']
    })

    // Write test prompt via stdin — keeps it off argv, consistent with runCliStream.
    // Swallow async EPIPE if the child dies before draining (see runCliStream for the full note).
    child.stdin!.on('error', () => {})
    try {
      child.stdin!.write('Reply with OK', 'utf8')
      child.stdin!.end()
    } catch {
      /* stdin already closed — handled below */
    }

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    child.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c))
    child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c))

    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) return
      void (async () => {
        if (tmpDir) {
          try {
            await rm(tmpDir, { recursive: true, force: true })
          } catch {
            /* best-effort */
          }
        }
        const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim()
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim()
        if (code === 0 && stdout.length > 0) {
          resolve({ ok: true })
        } else {
          resolve({
            ok: false,
            error: stderr.slice(-300) || (stdout ? `unexpected output: ${stdout.slice(0, 100)}` : 'no output — are you logged in?')
          })
        }
      })()
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      if (timedOut) return
      resolve({ ok: false, error: err.message })
    })
  })
}

// ─── setupCli ────────────────────────────────────────────────────────────────────

/**
 * Open a Terminal (macOS) or console (Windows) window that installs the CLI and walks the user
 * through interactive login. Mirrors setupDustCli() in dustcli.ts — writes a script and
 * shell.openPath's it: a .command file on macOS, a .cmd batch file on Windows (Windows opens .cmd
 * files in a console and runs them, so this needs no extra permission either).
 */
export async function setupCli(provider: ProviderId): Promise<{ ok: boolean; error?: string }> {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    const label = PROVIDERS[provider]?.label ?? provider
    return {
      ok: false,
      error: `Automatic setup isn't available on this OS yet. Install ${label} manually.`
    }
  }

  const isWin = process.platform === 'win32'
  let scriptLines: string[]

  if (isWin) {
    if (provider === 'claude-cli') {
      scriptLines = [
        '@echo off',
        'cls',
        'echo Métis - Claude Code CLI setup',
        'echo ================================',
        'echo.',
        'where npm >nul 2>nul',
        'if errorlevel 1 (',
        '  echo npm / Node.js not found. Install Node from https://nodejs.org, then run this again.',
        '  echo.',
        '  pause',
        '  exit /b 1',
        ')',
        'echo Step 1/2  Installing Claude Code CLI (npm i -g @anthropic-ai/claude-code)...',
        'call npm i -g @anthropic-ai/claude-code',
        'if errorlevel 1 (',
        '  echo.',
        '  echo Install failed - often a permissions issue. Try running this file as Administrator.',
        '  echo.',
        '  pause',
        '  exit /b 1',
        ')',
        'echo.',
        'echo Step 2/2  Signing in to Claude (type /login at the prompt below)...',
        'echo ----------------------------------------',
        'call claude',
        'echo.',
        'echo Done. Go back to Métis and click Connect again.',
        'pause'
      ]
    } else if (provider === 'codex-cli') {
      scriptLines = [
        '@echo off',
        'cls',
        'echo Métis - OpenAI Codex CLI setup',
        'echo =================================',
        'echo.',
        'where npm >nul 2>nul',
        'if errorlevel 1 (',
        '  echo npm / Node.js not found. Install Node from https://nodejs.org, then run this again.',
        '  echo.',
        '  pause',
        '  exit /b 1',
        ')',
        'echo Step 1/2  Installing OpenAI Codex CLI (npm i -g @openai/codex)...',
        'call npm i -g @openai/codex',
        'if errorlevel 1 (',
        '  echo.',
        '  echo Install failed - often a permissions issue. Try running this file as Administrator.',
        '  echo.',
        '  pause',
        '  exit /b 1',
        ')',
        'echo.',
        'echo Step 2/2  Signing in to OpenAI Codex...',
        'call codex login',
        'echo.',
        'echo Done. Go back to Métis and click Connect again.',
        'pause'
      ]
    } else {
      return { ok: false, error: `setupCli: unknown provider '${provider}'` }
    }
  } else if (provider === 'claude-cli') {
    scriptLines = [
      '#!/bin/bash',
      'clear',
      'echo "Métis — Claude Code CLI setup"',
      'echo "================================"',
      'echo',
      'if ! command -v npm >/dev/null 2>&1; then',
      '  echo "✗ npm / Node.js not found. Install Node from https://nodejs.org, then run this again."',
      '  echo; echo "Press any key to close."; read -n 1 -s; exit 1',
      'fi',
      'echo "Step 1/2  Installing Claude Code CLI (npm i -g @anthropic-ai/claude-code)…"',
      'if ! npm i -g @anthropic-ai/claude-code; then',
      '  echo; echo "✗ Install failed (often a permissions issue with global npm)."',
      '  echo "  Try:  sudo npm i -g @anthropic-ai/claude-code   then run this again."',
      '  echo; echo "Press any key to close."; read -n 1 -s; exit 1',
      'fi',
      'echo; echo "Step 2/2  Signing in to Claude (type /login at the prompt below)…"',
      'echo "────────────────────────────────────────────────"',
      'claude',
      'echo; echo "✓ Done. Go back to Métis and click \\"Connect\\" again."',
      'echo "You can close this window."'
    ]
  } else if (provider === 'codex-cli') {
    scriptLines = [
      '#!/bin/bash',
      'clear',
      'echo "Métis — OpenAI Codex CLI setup"',
      'echo "================================="',
      'echo',
      'if ! command -v npm >/dev/null 2>&1; then',
      '  echo "✗ npm / Node.js not found. Install Node from https://nodejs.org, then run this again."',
      '  echo; echo "Press any key to close."; read -n 1 -s; exit 1',
      'fi',
      'echo "Step 1/2  Installing OpenAI Codex CLI (npm i -g @openai/codex)…"',
      'if ! npm i -g @openai/codex; then',
      '  echo; echo "✗ Install failed (often a permissions issue with global npm)."',
      '  echo "  Try:  sudo npm i -g @openai/codex   then run this again."',
      '  echo; echo "Press any key to close."; read -n 1 -s; exit 1',
      'fi',
      'echo; echo "Step 2/2  Signing in to OpenAI Codex…"',
      'codex login',
      'echo; echo "✓ Done. Go back to Métis and click \\"Connect\\" again."',
      'echo "You can close this window."'
    ]
  } else {
    return { ok: false, error: `setupCli: unknown provider '${provider}'` }
  }

  try {
    const script = scriptLines.join('\n') + '\n'
    const scriptPath = join(app.getPath('temp'), `asktoto-${provider}-setup-${randomBytes(8).toString('hex')}.${isWin ? 'cmd' : 'command'}`)
    writeFileSync(scriptPath, script, { mode: 0o755, flag: 'wx' })
    const err = await shell.openPath(scriptPath)
    if (err) return { ok: false, error: err }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ─── installCli ──────────────────────────────────────────────────────────────────

/** Matches stderr indicating the global npm install lacked permission — mac/Linux report EACCES,
 *  Windows reports EPERM (e.g. a locked file, or a non-admin user without write access to the global
 *  npm prefix). Either way the caller should offer the Terminal/console fallback instead of retrying. */
export const INSTALL_PERMISSION_ERROR_RE = /EACCES|EPERM|permission denied|not permitted/i

/**
 * Install the CLI package for the given provider in-app, without opening a Terminal.
 * Uses the user's login shell (mac/Linux) or cmd.exe (Windows) so node/npm and the user's npm prefix
 * are on PATH. Progress lines are streamed to onProgress as they arrive.
 * Returns {ok:true} on success; {needsTerminal:true} on EACCES/EPERM; {ok:false, error} otherwise.
 */
export async function installCli(
  provider: ProviderId,
  onProgress: (line: string) => void
): Promise<CliInstallResult> {
  const cfg = CLI_CONFIGS[provider]
  if (!cfg) return { ok: false, error: 'No installer for this provider.' }

  const existing = await resolveBin(cfg.bin)
  if (existing) {
    onProgress('Already installed.')
    return { ok: true }
  }

  const pkg =
    provider === 'claude-cli'
      ? '@anthropic-ai/claude-code'
      : provider === 'codex-cli'
        ? '@openai/codex'
        : null

  if (!pkg) {
    return { ok: false, error: 'No installer for this provider.' }
  }

  return new Promise<CliInstallResult>((resolve) => {
    const loginShell = process.env.SHELL || '/bin/zsh'
    // pkg is a compile-time constant — no user input is interpolated here.
    const child =
      process.platform === 'win32'
        ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm', 'i', '-g', pkg], {
            env: process.env,
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
          })
        : spawn(loginShell, ['-lc', `npm i -g ${pkg}`], {
            env: process.env,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe']
          })

    const stderrLines: string[] = []

    function readLines(stream: NodeJS.ReadableStream): void {
      const rl = createInterface({ input: stream, crlfDelay: Infinity })
      rl.on('line', (line) => {
        const trimmed = line.trim()
        if (!trimmed) return
        onProgress(trimmed)
      })
    }

    // Collect stderr for error detection; also forward each line as progress.
    const stderrRl = createInterface({ input: child.stderr!, crlfDelay: Infinity })
    stderrRl.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      stderrLines.push(trimmed)
      onProgress(trimmed)
    })

    readLines(child.stdout!)

    child.on('error', (err) => {
      resolve({ ok: false, error: err.message })
    })

    child.on('close', (code) => {
      if (code === 0) {
        // Evict any stale null entry so resolveBin re-probes after a successful install.
        binCache.delete(cfg.bin)
        // Windows: PATH can still be stale in this very process right after the install (see
        // resolveBin) — pre-seed the cache from npm's default global-bin folder so the very next
        // resolveBin() call (e.g. the caller's immediate re-check) succeeds without waiting on `where`.
        if (process.platform === 'win32') {
          for (const candidate of npmGlobalBinCandidates(cfg.bin)) {
            if (existsSync(candidate)) {
              binCache.set(cfg.bin, candidate)
              break
            }
          }
        }
        resolve({ ok: true })
        return
      }
      const stderrText = stderrLines.join('\n')
      // Detect npm-not-found: the login shell prints 'command not found' (mac/Linux); cmd.exe prints
      // "'npm' is not recognized as an internal or external command..." (Windows).
      if (/command not found|not recognized as an internal/i.test(stderrText)) {
        resolve({
          ok: false,
          error: 'Node.js / npm not found. Install Node from nodejs.org, then try again.'
        })
        return
      }
      // Detect permission error → caller should offer the Terminal fallback
      if (INSTALL_PERMISSION_ERROR_RE.test(stderrText)) {
        resolve({ ok: false, needsTerminal: true, error: 'Global install needs admin permission.' })
        return
      }
      const tail = stderrText.slice(-300) || `Install failed (exit ${code}).`
      resolve({ ok: false, error: tail })
    })
  })
}

// ─── loginCli ────────────────────────────────────────────────────────────────────

/**
 * Open a Terminal (macOS) or console (Windows) window for interactive CLI login only (no npm
 * install step). The user has already installed the CLI in-app via installCli; this is the
 * companion step for providers that require an interactive login flow. Mirrors setupCli's pattern.
 */
export async function loginCli(provider: ProviderId): Promise<{ ok: boolean; error?: string }> {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    return {
      ok: false,
      error: `Automatic login isn't available on this OS yet. Run '${provider === 'claude-cli' ? 'claude' : 'codex login'}' in a terminal.`
    }
  }

  const isWin = process.platform === 'win32'
  let scriptLines: string[]

  if (isWin) {
    if (provider === 'claude-cli') {
      scriptLines = [
        '@echo off',
        'cls',
        'echo Métis - Claude Code CLI login',
        'echo ================================',
        'echo.',
        'echo Type /login at the prompt below and follow the instructions.',
        'echo ----------------------------------------',
        'call claude',
        'echo.',
        'echo Done. Go back to Métis and click Connect again.',
        'pause'
      ]
    } else if (provider === 'codex-cli') {
      scriptLines = [
        '@echo off',
        'cls',
        'echo Métis - OpenAI Codex CLI login',
        'echo =================================',
        'echo.',
        'echo Follow the instructions below to sign in.',
        'echo ----------------------------------------',
        'call codex login',
        'echo.',
        'echo Done. Go back to Métis and click Connect again.',
        'pause'
      ]
    } else {
      return { ok: false, error: `loginCli: unknown provider '${provider}'` }
    }
  } else if (provider === 'claude-cli') {
    scriptLines = [
      '#!/bin/bash',
      'clear',
      'echo "Métis — Claude Code CLI login"',
      'echo "================================"',
      'echo',
      'echo "Type /login at the prompt below and follow the instructions."',
      'echo "────────────────────────────────────────────────"',
      'claude',
      'echo; echo "✓ Done. Go back to Métis and click \\"Connect\\" again."',
      'echo "You can close this window."'
    ]
  } else if (provider === 'codex-cli') {
    scriptLines = [
      '#!/bin/bash',
      'clear',
      'echo "Métis — OpenAI Codex CLI login"',
      'echo "================================="',
      'echo',
      'echo "Follow the instructions below to sign in."',
      'echo "────────────────────────────────────────────────"',
      'codex login',
      'echo; echo "✓ Done. Go back to Métis and click \\"Connect\\" again."',
      'echo "You can close this window."'
    ]
  } else {
    return { ok: false, error: `loginCli: unknown provider '${provider}'` }
  }

  try {
    const script = scriptLines.join('\n') + '\n'
    const scriptPath = join(app.getPath('temp'), `asktoto-${provider}-login-${randomBytes(8).toString('hex')}.${isWin ? 'cmd' : 'command'}`)
    writeFileSync(scriptPath, script, { mode: 0o755, flag: 'wx' })
    const err = await shell.openPath(scriptPath)
    if (err) return { ok: false, error: err }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ─── prewarmCli ────────────────────────────────────────────────────────────────

/**
 * Pre-resolve the 'claude' and 'codex' binaries (in parallel) to warm the binCache, so the first CLI ask
 * doesn't pay the ~100-200ms login-shell lookup mid-stream. Fire-and-forget; errors are cached as null and
 * handled gracefully downstream. Cheap to call repeatedly — a cache hit is instant. Mirrors prewarmCapture().
 */
export function prewarmCli(): void {
  void Promise.all([resolveBin('claude'), resolveBin('codex')]).catch(() => {
    /* best-effort warm */
  })
}
