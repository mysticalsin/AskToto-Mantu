/**
 * CLI provider backend — claude-cli (Claude Code) and codex-cli (OpenAI Codex).
 *
 * SECURITY INVARIANTS (never relax):
 *   - No shell:true. All spawns pass args as an array.
 *   - claude-cli: --allowedTools '' --disallowedTools '*' so the agent can never execute arbitrary tools.
 *   - codex-cli: features.shell_tool=false + runs in a throwaway tmp cwd.
 *   - resolveBin() uses the login shell to find the absolute path — never relies on a minimal GUI PATH.
 */

import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { app, shell } from 'electron'
import { writeFileSync } from 'node:fs'
import type { ProviderId } from '@shared/providers'
import { PROVIDERS } from '@shared/providers'
import type { CliActionResult, CliInstallResult } from '@shared/ipc'

const execFileAsync = promisify(execFile)

// ─── Idle watchdog (mirrors llm.ts) ────────────────────────────────────────────
const STREAM_IDLE_MS = 120_000
// exported for unit tests (cli.test.ts) — security/reliability-critical, must stay covered
export function idleWatchdog(onIdle: () => void): { ping: () => void; clear: () => void } {
  let t: NodeJS.Timeout | null = setTimeout(onIdle, STREAM_IDLE_MS)
  return {
    ping: () => {
      if (t) clearTimeout(t)
      t = setTimeout(onIdle, STREAM_IDLE_MS)
    },
    clear: () => {
      if (t) {
        clearTimeout(t)
        t = null
      }
    }
  }
}

// ─── Binary resolution via login shell ──────────────────────────────────────────
const binCache = new Map<string, string | null>()

/**
 * Resolve a CLI binary to its absolute path using the user's login shell.
 * A packaged Electron app runs with a minimal PATH; the login shell loads the full environment
 * (nvm, homebrew, user profile, etc.) so `claude` / `codex` installed globally are found.
 * Results are cached in-process — resolveBin is called on every streaming request, so caching
 * prevents repeated shell spawns per conversation turn.
 */
export async function resolveBin(bin: string): Promise<string | null> {
  if (binCache.has(bin)) return binCache.get(bin) ?? null
  const shell = process.env.SHELL || '/bin/zsh'
  try {
    const { stdout } = await execFileAsync(shell, ['-lc', `command -v ${bin}`])
    const resolved = stdout.trim() || null
    binCache.set(bin, resolved)
    return resolved
  } catch {
    return null
  }
}

/** Env for spawning a CLI. For claude-cli, strip Claude-Code session + proxy vars so the spawned
 *  `claude` runs as a clean standalone invocation against the user's own keychain login (avoids a
 *  hang when AskToto is itself launched from a Claude Code session, and ignores a proxy base URL). */
export function cliEnv(provider: ProviderId): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (provider === 'claude-cli') {
    for (const k of Object.keys(env)) {
      if (/^CLAUDE_CODE/i.test(k) || k === 'CLAUDECODE' || k === 'CLAUDE_AGENT_SDK_VERSION' || k === 'CLAUDE_TMPDIR') {
        delete env[k]
      }
    }
    delete env.ANTHROPIC_BASE_URL
  } else if (provider === 'codex-cli') {
    delete env.OPENAI_BASE_URL
  }
  return env
}

// ─── Per-provider CLI config ─────────────────────────────────────────────────────

interface CliConfig {
  bin: string
  buildArgs(opts: { model: string; system: string; prompt: string }): string[]
  parseLine(line: string): string | null
  /** codex runs in a throwaway temp cwd so it never touches the user's project. */
  useTmpCwd: boolean
}

// exported for unit tests (cli.test.ts) — the locked-down arg arrays are a security invariant
export const CLI_CONFIGS: Partial<Record<ProviderId, CliConfig>> = {
  'claude-cli': {
    bin: 'claude',
    buildArgs({ model, system, prompt }) {
      return [
        '-p',
        prompt,
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
        ...(model ? ['--model', model] : []),
        ...(system ? ['--append-system-prompt', system] : [])
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
    buildArgs({ model, system, prompt }) {
      return [
        'exec',
        prompt,
        '--json',
        '--skip-git-repo-check',
        '-c',
        'features.shell_tool=false',
        ...(model ? ['-m', model] : []),
        ...(system ? ['-c', `developer_instructions=${system}`] : [])
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
  wd = idleWatchdog(() => {
    fail(`${label}: stream timed out — no output for ${STREAM_IDLE_MS / 1000}s.`)
    controller.abort()
  })

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

    const args = cfg.buildArgs({ model: opts.model, system: opts.system, prompt: opts.prompt })
    const child = spawn(absBin, args, {
      cwd,
      signal: controller.signal,
      env: cliEnv(opts.providerId),
      // SECURITY: never use shell:true — args are passed as an array
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })

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
    const { stdout } = await execFileAsync(absBin, ['--version'])
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
    testArgs = ['-p', 'Reply with OK', '--output-format', 'text', '--max-turns', '1', '--allowedTools', '']
  } else {
    // codex-cli: needs a throwaway cwd
    try {
      tmpDir = await mkdtemp(join(tmpdir(), 'asktoto-clitest-'))
      testCwd = tmpDir
    } catch {
      /* proceed without a dedicated cwd */
    }
    testArgs = ['exec', 'Reply with OK', '--skip-git-repo-check', '-c', 'features.shell_tool=false']
  }

  return new Promise<CliActionResult>((resolve) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      if (tmpDir) rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      resolve({ ok: false, error: 'Timed out after 45 s — are you logged in?' })
    }, TEST_TIMEOUT_MS)

    const child = spawn(absBin, testArgs, {
      cwd: testCwd,
      env: cliEnv(provider),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })

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
 * Open a Terminal window that installs the CLI and walks the user through interactive login.
 * Mirrors setupDustCli() in dustcli.ts — writes a .command script and shell.openPath's it.
 * macOS only (like the Dust equivalent).
 */
export async function setupCli(provider: ProviderId): Promise<{ ok: boolean; error?: string }> {
  if (process.platform !== 'darwin') {
    const label = PROVIDERS[provider]?.label ?? provider
    return {
      ok: false,
      error: `Automatic setup is macOS-only for now. Install ${label} manually.`
    }
  }

  let scriptLines: string[]

  if (provider === 'claude-cli') {
    scriptLines = [
      '#!/bin/bash',
      'clear',
      'echo "AskToto — Claude Code CLI setup"',
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
      'echo; echo "✓ Done. Go back to AskToto and click \\"Connect\\" again."',
      'echo "You can close this window."'
    ]
  } else if (provider === 'codex-cli') {
    scriptLines = [
      '#!/bin/bash',
      'clear',
      'echo "AskToto — OpenAI Codex CLI setup"',
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
      'echo; echo "✓ Done. Go back to AskToto and click \\"Connect\\" again."',
      'echo "You can close this window."'
    ]
  } else {
    return { ok: false, error: `setupCli: unknown provider '${provider}'` }
  }

  try {
    const script = scriptLines.join('\n') + '\n'
    const scriptPath = join(app.getPath('temp'), `asktoto-${provider}-setup.command`)
    writeFileSync(scriptPath, script, { mode: 0o755 })
    const err = await shell.openPath(scriptPath)
    if (err) return { ok: false, error: err }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ─── installCli ──────────────────────────────────────────────────────────────────

/**
 * Install the CLI package for the given provider in-app, without opening a Terminal.
 * Uses the user's login shell so node/npm and the user's npm prefix are on PATH.
 * Progress lines are streamed to onProgress as they arrive.
 * Returns {ok:true} on success; {needsTerminal:true} on EACCES; {ok:false, error} otherwise.
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
    const child = spawn(loginShell, ['-lc', `npm i -g ${pkg}`], {
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
        resolve({ ok: true })
        return
      }
      const stderrText = stderrLines.join('\n')
      // Detect npm-not-found: npm missing means the shell printed 'command not found'
      if (/command not found/i.test(stderrText)) {
        resolve({
          ok: false,
          error: 'Node.js / npm not found. Install Node from nodejs.org, then try again.'
        })
        return
      }
      // Detect permission error → caller should offer the Terminal fallback
      if (/EACCES|permission denied|not permitted/i.test(stderrText)) {
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
 * Open a Terminal window for interactive CLI login only (no npm install step).
 * The user has already installed the CLI in-app via installCli; this is the
 * companion step for providers that require an interactive login flow.
 * macOS only — mirrors setupCli's Terminal pattern.
 */
export async function loginCli(provider: ProviderId): Promise<{ ok: boolean; error?: string }> {
  if (process.platform !== 'darwin') {
    const label = PROVIDERS[provider]?.label ?? provider
    return {
      ok: false,
      error: `Automatic login is macOS-only for now. Run '${provider === 'claude-cli' ? 'claude' : 'codex login'}' in a Terminal.`
    }
  }

  let scriptLines: string[]

  if (provider === 'claude-cli') {
    scriptLines = [
      '#!/bin/bash',
      'clear',
      'echo "AskToto — Claude Code CLI login"',
      'echo "================================"',
      'echo',
      'echo "Type /login at the prompt below and follow the instructions."',
      'echo "────────────────────────────────────────────────"',
      'claude',
      'echo; echo "✓ Done. Go back to AskToto and click \\"Connect\\" again."',
      'echo "You can close this window."'
    ]
  } else if (provider === 'codex-cli') {
    scriptLines = [
      '#!/bin/bash',
      'clear',
      'echo "AskToto — OpenAI Codex CLI login"',
      'echo "================================="',
      'echo',
      'echo "Follow the instructions below to sign in."',
      'echo "────────────────────────────────────────────────"',
      'codex login',
      'echo; echo "✓ Done. Go back to AskToto and click \\"Connect\\" again."',
      'echo "You can close this window."'
    ]
  } else {
    return { ok: false, error: `loginCli: unknown provider '${provider}'` }
  }

  try {
    const script = scriptLines.join('\n') + '\n'
    const scriptPath = join(app.getPath('temp'), `asktoto-${provider}-login.command`)
    writeFileSync(scriptPath, script, { mode: 0o755 })
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
