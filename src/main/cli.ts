/**
 * CLI provider backend — claude-cli (Claude Code) and codex-cli (OpenAI Codex).
 *
 * SECURITY INVARIANTS (never relax):
 *   - No shell:true. All spawns pass args as an array. On Windows, a `.cmd` npm shim is launched via
 *     cmd.exe as the *target executable* (see resolveSpawnTarget) — that is not shell:true, and any
 *     free-text ARG containing a quote, newline, or a cmd.exe command-separator/expansion
 *     metacharacter (&|^%<>()!) is rejected first (see cmdShimSpawn). The resolved bin path itself is
 *     not free text (it comes from resolveBin), so it is only guarded against quote/newline/% and is
 *     otherwise made safe by explicit quoting + windowsVerbatimArguments (see cmdShimSpawn).
 *   - claude-cli: --allowedTools '' --disallowedTools '*' so the agent can never execute arbitrary tools.
 *   - codex-cli: features.shell_tool=false + runs in a throwaway tmp cwd.
 *   - resolveBin() finds the absolute path via the login shell (mac/Linux) or `where` + an APPDATA
 *     probe (Windows) — never relies on a minimal GUI PATH.
 */

import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { app, shell } from 'electron'
import { existsSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import type { ProviderId } from '@shared/providers'
import { PROVIDERS } from '@shared/providers'
import type { CliActionResult, CliInstallResult } from '@shared/ipc'
import { managedCliEntry, installManagedCli } from './cli-installer'

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

// ─── Known Windows system-binary fallbacks, pinned absolute ────────────────────────────────────
// Windows CreateProcess resolves a bare filename by searching the launching app's own directory, then
// the CURRENT WORKING DIRECTORY, before it ever consults PATH — so a bare 'cmd.exe'/'where' could be
// shadowed by a binary planted in an attacker-writable cwd. Pin these known system binaries to their
// absolute %SystemRoot%\System32 path so that search order can never resolve an impostor.
function system32(name: string): string {
  // Explicit backslashes, not join(): these paths are only ever consumed by Windows CreateProcess, and
  // host-native join() would emit '/' separators when the win32 branch runs under a platform-pinned test.
  return `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\${name}`
}

/** cmd.exe target for cmdShimSpawn/installCli: prefer a valid absolute ComSpec (the user's real shell)
 *  when one is set, else pin to the known System32 binary rather than trust a bare 'cmd.exe' name. */
function comSpecExe(): string {
  const cs = process.env.ComSpec
  return cs && isAbsolute(cs) ? cs : system32('cmd.exe')
}

/** On the Windows `.cmd`-shim path the spawned process is cmd.exe, which in turn launches the real
 *  node/claude (or node/codex) process as a grandchild. Aborting/killing only the immediate child
 *  (cmd.exe) does not cascade to that grandchild — it keeps running to completion, orphaned. `taskkill
 *  /T` recurses the whole process tree rooted at pid; `/F` force-terminates. Best-effort: the process
 *  may have already exited by the time this fires, so failures are swallowed. No-op on non-Windows,
 *  where the plain child.kill() the caller already does is sufficient (no shim indirection).
 *
 *  Exported because dustcli.ts needs exactly this behaviour for the same reason (MQA-019: a timed-out
 *  `dust status` orphaned its grandchild, which then rotated the single-use OAuth refresh token and
 *  invalidated the session). It briefly existed as a copy there; two copies of a process-kill helper
 *  drift, and the one that drifts is the one that stops killing the grandchild.
 */
export function killWindowsProcessTree(pid: number | undefined): void {
  if (!pid || process.platform !== 'win32') return
  execFile(system32('taskkill.exe'), ['/pid', String(pid), '/T', '/F'], () => {
    /* best-effort — nothing to do if the tree is already gone */
  })
}

// ─── Binary resolution: login shell (mac/Linux) or `where` + npm global probe (Windows) ────────
const binCache = new Map<string, string | null>()

/**
 * Drop every cached binary lookup (MQA-251).
 *
 * resolveBin's cache is a module-level Map consulted BEFORE the platform branch, which makes it a piece
 * of state that outlives any single test. On a developer machine with a real CLI installed, one lookup
 * cached an absolute Windows path; every later test that stubbed process.platform to darwin then got that
 * Windows path back and spawned through cmd.exe, so its POSIX-shaped assertions failed. On a machine with
 * no CLI installed the cache stayed empty (only positive hits are cached) and the same tests passed.
 *
 * That is why the failure looked like flakiness: it was deterministic per machine, and per test ORDER,
 * but not per commit. Exported so a test can start from a known-empty cache instead of inheriting
 * whichever lookup happened to run first.
 */
export function clearBinCache(): void {
  binCache.clear()
}

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
      // flashes on screen even though nothing is printed to it. Absolute System32 path (not bare
      // 'where') so a planted where.exe earlier on PATH/cwd can't hijack the lookup.
      const { stdout } = await execFileAsync(system32('where.exe'), [bin], { windowsHide: true })
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
    return managedBinFallback(bin)
  }

  const shell = process.env.SHELL || '/bin/zsh'
  try {
    const { stdout } = await execFileAsync(shell, ['-lc', `command -v ${bin}`])
    const resolved = stdout.trim() || null
    // Only cache positive hits; null (not-found) must not be cached so that a subsequent
    // in-app install is picked up immediately without requiring an app restart.
    if (resolved !== null) binCache.set(bin, resolved)
    if (resolved !== null) return resolved
  } catch {
    /* fall through to the managed-CLI probe */
  }
  return managedBinFallback(bin)
}

/** Last-resort resolution: the in-app one-click install (cli-installer.ts). Returns the managed entry
 *  script path — resolveSpawnTarget() recognizes it and runs it on Electron's embedded Node. Never
 *  cached, so an install completing mid-session is picked up on the next ask; a system install appearing
 *  later still wins (probed first). */
function managedBinFallback(bin: string): string | null {
  const id = bin === 'claude' ? 'claude' : bin === 'codex' ? 'codex' : null
  if (!id) return null
  try {
    return managedCliEntry(id)?.entry ?? null
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
 * specially, so any free-text ARG containing one of those is rejected before the command line is
 * built. Not every arg that reaches this function is a fixed constant: the model id can be free text a
 * user typed into Settings (codex-cli has no fixed model list, and the brain-ingest path can deliver a
 * model string without going through the interactive guardrail) — free-text prompt/system content
 * always goes via stdin, never argv, but the model id does not, which is exactly why this backstop
 * exists.
 *
 * The bin path is different: it is resolveBin's own RESOLVED absolute path, not user-typed text, so a
 * legitimate install under e.g. `C:\Users\R&D\...\claude.cmd` or `C:\Program Files (x86)\...\claude.cmd`
 * must still be launchable. We wrap `"${bin}"` plus the (already-guarded) args in one outer quote pair
 * and pass windowsVerbatimArguments:true so libuv does not re-quote our hand-built line — cmd.exe /s
 * peels exactly that one outer pair, leaving `"<bin>" <args>` to run correctly even with spaces or
 * cmd.exe metacharacters in the path. (Plain array-quoting without windowsVerbatimArguments does NOT
 * work here: libuv would additionally quote a spaced bin itself, and cmd /s's single unwrap does not
 * undo that nested quoting — confirmed empirically.)
 */
export function cmdShimSpawn(
  bin: string,
  args: string[]
): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  for (let i = 0; i < args.length; i++) {
    if (/["\r\n&|^%<>()!]/.test(args[i])) {
      // Name the flag the rejected value belongs to. Every arg here is a fixed constant except the
      // model id, so "the value for '-m'" is the difference between a user who knows to change the
      // model in Settings and one who only sees an unattributable refusal (MQA-087). The value itself
      // is never echoed — it is free text.
      const flag = i > 0 ? args[i - 1] : ''
      throw new Error(
        `refusing to spawn: the ${flag ? `value for '${flag}'` : 'argument'} contains a quote, newline, or cmd.exe metacharacter (unsafe for cmd.exe)`
      )
    }
  }
  // bin is the RESOLVED absolute .cmd path from resolveBin — never free text — so it only needs
  // guarding against the characters explicit quoting below cannot neutralize: a quote/newline would
  // break out of the wrapping quotes, and % triggers cmd.exe %VAR% expansion even inside quotes.
  // Spaces, &, |, ^, <, >, (, ), ! in bin are all made safe by the explicit outer+inner quoting.
  if (/["\r\n%]/.test(bin)) {
    throw new Error(
      'refusing to spawn: the resolved binary path contains a quote, newline, or % (unsafe for cmd.exe)'
    )
  }
  // Build the full command line ourselves and wrap it in one outer quote pair, then tell libuv not to
  // re-quote it (windowsVerbatimArguments). cmd.exe /s peels exactly that one outer pair, leaving
  // `"<bin>" <args>` — which runs correctly even when bin contains spaces/metacharacters, or args is
  // empty. Without windowsVerbatimArguments, libuv would itself quote the spaced bin, producing a
  // second, nested quote pair that cmd /s's single unwrap does not fully undo (see file header).
  // Quote EVERY argument, not just bin. Joining raw args on a space loses two whole classes of
  // argument: an empty string contributes nothing and disappears from the child's argv entirely, and
  // an argument containing a space arrives as two. Both matter here — buildArgs emits
  // `--allowedTools ''` and the codex `--model` value is free text a user can type into Settings —
  // so the unquoted form silently delivered `--allowedTools --disallowedTools *`, dropping the
  // tool-lockdown invariant this file's header declares must never be relaxed.
  // Quoting is safe unconditionally: the guard above rejects `"` and `%` in every arg, cmd.exe does
  // not glob, and the child's CRT strips the quotes, so `"*"` still reaches the child as `*`. cmd /s
  // still peels exactly the one outer pair; these inner pairs are untouched.
  const inner = [`"${bin}"`, ...args.map((a) => `"${a}"`)].join(' ')
  return { command: comSpecExe(), args: ['/d', '/s', '/c', `"${inner}"`], windowsVerbatimArguments: true }
}

/** True when `bin` is a managed-CLI entry script installed by cli-installer.ts (one-click onboarding)
 *  rather than a system binary — those run on Electron's embedded Node, not directly. */
export function isManagedCliEntry(bin: string): boolean {
  return /[/\\]managed-cli[/\\].*\.[cm]?js$/.test(bin)
}

/** Resolve the actual { command, args, env? } to spawn for a CLI binary: direct on macOS/Linux and for
 *  Windows .exe binaries; routed through cmd.exe for Windows .cmd shims (see cmdShimSpawn above);
 *  managed-CLI entry scripts (in-app one-click install) run under process.execPath with
 *  ELECTRON_RUN_AS_NODE=1 — Electron's own binary as a plain Node runtime, so the user never installs
 *  Node. The env additions are merged over cliEnv() by the spawn sites. */
export function resolveSpawnTarget(
  bin: string,
  args: string[]
): { command: string; args: string[]; env?: Record<string, string>; windowsVerbatimArguments?: boolean } {
  if (isManagedCliEntry(bin)) {
    return { command: process.execPath, args: [bin, ...args], env: { ELECTRON_RUN_AS_NODE: '1' } }
  }
  return isCmdShim(bin) ? cmdShimSpawn(bin, args) : { command: bin, args }
}

// ─── Per-provider CLI config ─────────────────────────────────────────────────────

interface CliConfig {
  bin: string
  // Builds the argv list. Prompt and system content are delivered via stdin, never as argv
  // args — prevents transcript/system text from appearing in `ps -ww` / /proc/<pid>/cmdline.
  buildArgs(opts: { model: string }): string[]
  parseLine(line: string): string | null
  /** True when `line` is the stream's own verified terminal marker. Optional — only implemented where
   *  the terminal-line schema is confirmed (claude-cli's `type:'result'`); left unset for providers
   *  whose terminal marker is unverified. When it matches, runCliStream settles + aborts immediately
   *  instead of waiting for process exit — claude-cli's own global hooks can keep the child alive well
   *  past the result line, which would otherwise trip the idle watchdog into a false timeout. */
  isResultLine?(line: string): boolean
  /** The CLI's own error text when `line` is a terminal marker reporting a FAILED run, else null.
   *  Optional, and only meaningful next to isResultLine: a failure-shaped terminal line ships zero text
   *  deltas, so settling it as success hands the renderer a blank answer AND strands the ask — the
   *  caller's provider waterfall only ever advances from onError. */
  errorResultLine?(line: string): string | null
  /** codex runs in a throwaway temp cwd so it never touches the user's project. */
  useTmpCwd: boolean
}

/** claude-cli flags a failed run on the very same terminal `type:'result'` line it uses for a good one:
 *  `is_error:true` with an `error_*` subtype (error_during_execution, error_max_turns, …). A subscription
 *  limit reached mid-waterfall is the everyday case, and it produces no text at all. */
function isErrorResult(obj: { is_error?: unknown; subtype?: unknown }): boolean {
  return obj.is_error === true || String(obj.subtype ?? '').startsWith('error_')
}

// exported for unit tests (cli.test.ts) — the locked-down arg arrays are a security invariant
export const CLI_CONFIGS: Partial<Record<ProviderId, CliConfig>> = {
  'claude-cli': {
    bin: 'claude',
    buildArgs({ model }) {
      // '-p' with no positional arg puts claude in print/non-interactive mode reading from stdin.
      // system + prompt are written to child.stdin after spawn — never exposed in argv.
      // '--model' is unconditional: an empty model must never silently inherit the user's own CLI
      // default (which can be a premium model) — floor to the cheapest current model instead.
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
        '--model',
        model || 'sonnet'
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
    // End-of-answer detection, verified against live streams twice (2026-08-05): when the user's global
    // Claude Code hooks linger, the terminal type:'result' line is NOT flushed until teardown completes
    // — it arrives ~60-75s after the answer, i.e. AFTER the idle watchdog has already fired. The marker
    // that reliably arrives the moment the answer finishes is the message_stop stream event. With this
    // invocation locked to --max-turns 1 and all tools disallowed there is exactly one assistant message
    // per run, so message_stop IS end-of-answer. type:'result' is kept as a fallback for configs whose
    // hooks don't linger (it then arrives promptly and first).
    isResultLine(line) {
      try {
        const obj = JSON.parse(line)
        // SUCCESS-only: type:'result' also carries FAILED runs (see errorResultLine below), and those
        // must reach onError, not onDone.
        if (obj.type === 'result') return !isErrorResult(obj)
        return obj.type === 'stream_event' && obj.event?.type === 'message_stop'
      } catch {
        return false
      }
    },
    errorResultLine(line) {
      try {
        const obj = JSON.parse(line)
        if (obj.type !== 'result' || !isErrorResult(obj)) return null
        // `result` holds the human-readable cause ("Claude AI usage limit reached|…"); parseLine only
        // ever emits text_delta, so this line is the ONLY place that text exists. Capped like the
        // stderr path below — a CLI can dump a lot into it.
        const text = typeof obj.result === 'string' ? obj.result.trim() : ''
        return (text || String(obj.subtype ?? '') || 'the CLI reported a failed run').slice(0, 500)
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

/** True when `line` is a structured event from the CLI's own JSON protocol, as opposed to free-text
 *  chatter (claude-cli's global hooks log to stdout too). Only protocol lines count as proof that the
 *  child is alive — see the watchdog ping site in runCliStream. */
function isProtocolLine(line: string): boolean {
  try {
    const obj: unknown = JSON.parse(line)
    return typeof obj === 'object' && obj !== null
  } catch {
    return false
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

    // Everything above this point awaited — resolveBin shells out to `where.exe`/the login shell on a
    // cold cache and mkdtemp is a real libuv boundary on every codex ask — so a Stop / new-chat /
    // window-close abort can land BEFORE the spawn below. On the Windows .cmd-shim path spawn() is
    // deliberately given no signal (see below) and the whole teardown is an 'abort' listener, which
    // never fires when it is attached to an ALREADY-aborted signal. Spawning here would therefore
    // start a cmd.exe → claude/codex tree that nothing ever taskkills: it runs the cancelled turn to
    // completion and outlives the app (MQA-050). Bail before the spawn instead — the caller cancelled,
    // so there is nothing to report.
    if (controller.signal.aborted) {
      await cleanup()
      return
    }

    const args = cfg.buildArgs({ model: opts.model })
    let spawnTarget: { command: string; args: string[]; env?: Record<string, string>; windowsVerbatimArguments?: boolean }
    try {
      // Windows .cmd shims must go through cmd.exe (see resolveSpawnTarget); everything else spawns
      // directly, byte-identical to before.
      spawnTarget = resolveSpawnTarget(absBin, args)
    } catch (e) {
      wd.clear()
      // The sandbox cwd was already created above and no child is ever spawned on this path, so the
      // 'close' handler that normally cleans up can't run — without this every rejected ask orphans an
      // asktoto-cli-* directory in %TEMP% (MQA-087). Mirrors the same catch in testCli.
      await cleanup()
      return fail(`${label}: ${e instanceof Error ? e.message : 'refusing unsafe spawn arguments'}`)
    }
    const child = spawn(spawnTarget.command, spawnTarget.args, {
      cwd,
      // Do NOT hand the signal to spawn on the Windows .cmd-shim path. Node registers its own abort
      // listener INSIDE spawn(), before the explicit listener below, and abort listeners fire in
      // registration order — so Node killed cmd.exe first and the taskkill that follows found a dead
      // pid ("process not found"), never walked the tree, and left the real claude/codex grandchild
      // running. Making the explicit listener the single teardown path means nothing races taskkill
      // to kill cmd.exe. Every other target keeps the built-in behaviour.
      signal: spawnTarget.windowsVerbatimArguments ? undefined : controller.signal,
      env: { ...cliEnv(opts.providerId), ...spawnTarget.env },
      // SECURITY: never use shell:true — args are passed as an array. On Windows, cmd.exe may be the
      // spawn target for a .cmd shim (see resolveSpawnTarget) but it is never invoked as a shell here.
      shell: false,
      // Every 'Ask' spawns this — without windowsHide a console window flashes on top of the
      // always-on-top overlay (and anything the user is screen-sharing) on every single call.
      windowsHide: true,
      // Only set for a .cmd-shim target: tells libuv not to re-quote the hand-built cmd.exe command
      // line (see cmdShimSpawn). undefined for the non-shim branch — unchanged behavior there.
      windowsVerbatimArguments: spawnTarget.windowsVerbatimArguments,
      // 'pipe' for stdin so we can write prompt + system without exposing them in argv
      stdio: ['pipe', 'pipe', 'pipe']
    })
    // AbortController's own signal-linked kill only terminates this immediate child — on the Windows
    // .cmd-shim path that's cmd.exe, not the grandchild claude/codex node process (see
    // killWindowsProcessTree). On that path spawn() was given no signal (above), so this teardown is
    // the whole teardown: taskkill /T reaps cmd.exe AND its descendants while cmd.exe is still alive
    // and the tree is still walkable. Elsewhere Node has already killed the child and this is the
    // harmless cascade it always was.
    const teardown = (): void => {
      killWindowsProcessTree(child.pid)
      // taskkill is async and only exists on win32; on every other platform the shim path never
      // applies, so nothing was killed above and the child still needs terminating.
      if (process.platform !== 'win32') child.kill()
    }
    // addEventListener on an already-aborted signal NEVER fires — the event has come and gone. Any
    // abort that slips in after the guard above would then leave the tree with no teardown at all, so
    // run it directly in that case rather than registering a listener that can never run (MQA-050).
    if (controller.signal.aborted) teardown()
    else controller.signal.addEventListener('abort', teardown, { once: true })

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
      // The budget above is IDLE time, not a ceiling on the run: every protocol line proves the child
      // is alive and working. codex-cli's parseLine returns text only for the FINISHED answer
      // (item.completed/agent_message), so pinging from the delta branch alone left the timer
      // unpingable for the whole `codex exec` run — a live suggest (15s) or a base ask (45s) was
      // killed while the model was still reasoning, discarding an answer already in flight (MQA-040).
      // Free-text chatter deliberately does NOT ping, so a genuinely hung CLI still times out.
      if (!settled && isProtocolLine(line)) wd.ping()
      try {
        const text = cfg.parseLine(line)
        if (text !== null) {
          opts.handlers.onDelta(text)
        }
      } catch {
        // Non-JSON lines (e.g. status messages) are silently ignored
      }
      // Settle on the stream's own terminal marker rather than waiting for process exit: claude-cli's
      // own global hooks can keep the child alive well after this line ships, which would otherwise
      // trip the idle watchdog into a false 'stream timed out' error. Abort reuses the existing
      // signal-linked kill plumbing (incl. killWindowsProcessTree) to tear the child down now.
      if (!settled && !controller.signal.aborted) {
        // A terminal line can just as well report a FAILED run. It carries no text deltas, so settling
        // it as success would paint the idle "Ask a question…" placeholder over a dead provider and
        // stop the waterfall dead — the caller only fails over to the next provider from onError.
        const cliError = cfg.errorResultLine?.(line)
        if (cliError) {
          fail(`${label}: ${cliError}`)
          controller.abort()
        } else if (cfg.isResultLine?.(line)) {
          settled = true
          wd.clear()
          opts.handlers.onDone({})
          controller.abort()
        }
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

  // Windows .cmd shims must go through cmd.exe (see resolveSpawnTarget) — the same EINVAL landmine
  // as the spawn() call sites below, just reached via execFile here instead. This must be its OWN
  // try/catch: a resolveSpawnTarget throw (unsafe shim path) is a real failure and must not be
  // swallowed by the --version catch below, which is only meant for "binary present but --version
  // errored" and would otherwise misreport a broken CLI as connected.
  let spawnTarget: { command: string; args: string[]; env?: Record<string, string>; windowsVerbatimArguments?: boolean }
  try {
    spawnTarget = resolveSpawnTarget(absBin, ['--version'])
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'refusing unsafe spawn arguments' }
  }
  try {
    const { stdout } = await execFileAsync(spawnTarget.command, spawnTarget.args, {
      windowsHide: true,
      windowsVerbatimArguments: spawnTarget.windowsVerbatimArguments,
      env: { ...process.env, ...spawnTarget.env }
    })
    return { ok: true, version: stdout.trim().slice(0, 40) }
  } catch {
    // --version might fail on some builds; binary is present but couldn't run
    return { ok: true, version: 'installed' }
  }
}

// ─── checkCliSession ─────────────────────────────────────────────────────────────

/** How long the status probe below may take. These are local commands that read a credential file and
 *  print — they answer in well under a second — so this is a stuck-process backstop, not a budget. */
const SESSION_PROBE_TIMEOUT_MS = 8_000

/**
 * MQA-062: is a CLI provider we recorded as connected actually able to serve an ask RIGHT NOW?
 *
 * `cliConnected` was write-once until the ask path learned to retire it on a credential rejection — which
 * means the app still asserts a dead CLI is ready until the user asks something and gets an error. Dust
 * solves the identical problem by re-verifying the real session when Settings opens (see
 * renderer/lib/dust-live-check.ts: "Persisted state can lie"); this is the CLI equivalent.
 *
 * Deliberately NOT `testCli`. That runs a real one-turn completion: a 45 s timeout, a spawned child, and a
 * turn billed against the user's own CLI subscription — unacceptable to fire whenever a settings panel
 * opens. Both CLIs instead ship a documented, zero-token status command that reads their stored
 * credential and prints (`claude auth status`, which emits JSON carrying `loggedIn`; `codex login
 * status`, which prints a line and exits non-zero when there is no session), which is what this uses.
 * Both were exercised live against the installed CLIs before this was written — `claude auth status`
 * takes no `--output-format` flag, it is already JSON.
 *
 * Three-valued ON PURPOSE, and 'unknown' is the safe default. A false "signed out" verdict would retire a
 * perfectly good connection and send the user to reconnect for no reason, so anything this probe cannot
 * read confidently — an unrecognised output shape, a CLI version without the subcommand, a timeout —
 * answers 'unknown' and changes nothing. Only an explicit negative retires the flag.
 */
export async function checkCliSession(provider: ProviderId): Promise<'live' | 'signed-out' | 'unknown'> {
  const cfg = CLI_CONFIGS[provider]
  if (!cfg) return 'unknown'

  // The binary itself is gone (uninstalled, npm prefix changed, PATH edited) — the one variant of this
  // finding that involves no auth at all, and the only one nothing else catches: the ask path's
  // retireCli is gated on isAuthFailure, and "not installed" is not an auth failure.
  //
  // Looked up TWICE before believing it, because resolveBin cannot distinguish "confirmed absent" from
  // "the lookup itself failed" — on mac/Linux it shells out to the login shell, which can fail
  // transiently, and it deliberately caches only positive hits so a second call is a real second lookup.
  // A genuinely uninstalled CLI answers null both times; a hiccup answers once.
  let absBin = await resolveBin(cfg.bin)
  if (!absBin) absBin = await resolveBin(cfg.bin)
  if (!absBin) return 'signed-out'

  const args = provider === 'claude-cli' ? ['auth', 'status'] : ['login', 'status']
  let spawnTarget: { command: string; args: string[]; env?: Record<string, string>; windowsVerbatimArguments?: boolean }
  try {
    spawnTarget = resolveSpawnTarget(absBin, args)
  } catch {
    return 'unknown' // refusing an unsafe shim path is not evidence about the session
  }

  let stdout: string
  try {
    const r = await execFileAsync(spawnTarget.command, spawnTarget.args, {
      windowsHide: true,
      windowsVerbatimArguments: spawnTarget.windowsVerbatimArguments,
      timeout: SESSION_PROBE_TIMEOUT_MS,
      // Same env scrubbing a real ask uses: an ANTHROPIC_API_KEY in the environment must not make a
      // logged-OUT CLI report itself as authenticated (cliEnv strips exactly those vars).
      env: { ...cliEnv(provider), ...spawnTarget.env }
    })
    stdout = String(r.stdout ?? '')
  } catch (e) {
    // A non-zero exit is how codex reports "not logged in". claude answers 0 either way and puts the
    // verdict in its JSON, so for claude a throw here is a malfunctioning probe, not a verdict.
    const timedOut = (e as { killed?: boolean }).killed === true
    if (timedOut || provider === 'claude-cli') return 'unknown'
    return 'signed-out'
  }

  if (provider === 'claude-cli') {
    try {
      const parsed: unknown = JSON.parse(stdout)
      const loggedIn = (parsed as { loggedIn?: unknown }).loggedIn
      if (loggedIn === true) return 'live'
      if (loggedIn === false) return 'signed-out'
    } catch {
      /* not the JSON shape this version emits — fall through to 'unknown' */
    }
    return 'unknown'
  }
  // codex prints e.g. "Logged in using ChatGPT" on success; only an explicit negative is a verdict.
  if (/\bnot logged in\b/i.test(stdout)) return 'signed-out'
  if (/\blogged in\b/i.test(stdout)) return 'live'
  return 'unknown'
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
    // The lockdown flags and '--model' are not optional here either (MQA-086): this spawn hits the
    // same live CLI login as a real ask, and '--allowedTools ""' alone is not a deny-all — Claude
    // Code's allow list is additive over the user's own settings.json, so a bypassPermissions config
    // would leave their auto-approved tools live for this turn. An absent '--model' is the same
    // premium-default inheritance buildArgs floors to sonnet, and it would also report "connected"
    // without proving the binary can take --model. Interactive asks pick haiku/sonnet/opus per tier.
    testArgs = [
      '-p',
      '--output-format',
      'text',
      '--max-turns',
      '1',
      '--allowedTools',
      '',
      '--disallowedTools',
      '*',
      '--model',
      'sonnet'
    ]
  } else {
    // codex-cli: needs a throwaway cwd so the probe never runs in — or writes to — the user's project.
    // Falling through to the app's own cwd on failure silently dropped that invariant, so fail the
    // test the way runCliStream does instead (MQA-086).
    try {
      tmpDir = await mkdtemp(join(tmpdir(), 'asktoto-clitest-'))
      testCwd = tmpDir
    } catch {
      return { ok: false, error: `${label}: could not create a sandbox working directory.` }
    }
    // 'exec' with no positional arg reads the prompt from stdin (consistent with runCliStream).
    testArgs = ['exec', '--skip-git-repo-check', '-c', 'features.shell_tool=false']
  }

  let spawnTarget: { command: string; args: string[]; env?: Record<string, string>; windowsVerbatimArguments?: boolean }
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
      // On the Windows .cmd-shim path child is cmd.exe, not the real claude/codex process — a bare
      // SIGTERM only kills cmd.exe and orphans the grandchild (see killWindowsProcessTree). Cascade the
      // kill on Windows; a plain SIGTERM is sufficient elsewhere (no shim indirection).
      if (process.platform === 'win32') {
        killWindowsProcessTree(child.pid)
      } else {
        child.kill('SIGTERM')
      }
      if (tmpDir) rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      resolve({ ok: false, error: 'Timed out after 45 s — are you logged in?' })
    }, TEST_TIMEOUT_MS)

    const child = spawn(spawnTarget.command, spawnTarget.args, {
      cwd: testCwd,
      env: { ...cliEnv(provider), ...spawnTarget.env },
      // SECURITY: never use shell:true. cmd.exe may be the spawn target for a Windows .cmd shim (see
      // resolveSpawnTarget) but it is never invoked as a shell here.
      shell: false,
      // Runs on every Connect/Test-connection click — without this a console window flashes.
      windowsHide: true,
      // Only set for a .cmd-shim target (see cmdShimSpawn / runCliStream's spawn for the full note).
      windowsVerbatimArguments: spawnTarget.windowsVerbatimArguments,
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
 * through interactive login: writes a script and shell.openPath's it — a .command file on macOS, a
 * .cmd batch file on Windows (Windows opens .cmd files in a console and runs them, so this needs no
 * extra permission either). Dust's own sign-in no longer uses this pattern — see main/dust-oauth.ts's
 * native OAuth device flow — kept here for the CLI providers (Claude Code, Codex) that genuinely are a
 * system-installed CLI with an interactive terminal login.
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

  // Windows batch bodies: plain ASCII only — the default console codepage mangles accents/emoji —
  // and `^(` escapes parens for echo.
  if (isWin) {
    if (provider === 'claude-cli') {
      scriptLines = [
        '@echo off',
        'cls',
        'echo Metis - Claude Code CLI setup',
        'echo ================================',
        'echo.',
        'where npm >nul 2>nul',
        'if errorlevel 1 (',
        '  echo npm / Node.js not found. Install Node from https://nodejs.org, then run this again.',
        '  echo.',
        '  pause',
        '  exit /b 1',
        ')',
        'echo Step 1/2  Installing Claude Code CLI ^(npm i -g @anthropic-ai/claude-code^)...',
        'call npm i -g @anthropic-ai/claude-code',
        'if errorlevel 1 (',
        '  echo.',
        '  echo Install failed - often a permissions issue. Try running this file as Administrator.',
        '  echo.',
        '  pause',
        '  exit /b 1',
        ')',
        'echo.',
        'echo Step 2/2  Signing in to Claude ^(type /login at the prompt below^)...',
        'echo ----------------------------------------',
        'call claude',
        'echo.',
        'echo Done. Go back to Metis and click Connect again.',
        'pause'
      ]
    } else if (provider === 'codex-cli') {
      scriptLines = [
        '@echo off',
        'cls',
        'echo Metis - OpenAI Codex CLI setup',
        'echo =================================',
        'echo.',
        'where npm >nul 2>nul',
        'if errorlevel 1 (',
        '  echo npm / Node.js not found. Install Node from https://nodejs.org, then run this again.',
        '  echo.',
        '  pause',
        '  exit /b 1',
        ')',
        'echo Step 1/2  Installing OpenAI Codex CLI ^(npm i -g @openai/codex^)...',
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
        'echo Done. Go back to Metis and click Connect again.',
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
      ...npmInstallWithDiagnosis('@anthropic-ai/claude-code', 'Step 1/2  Installing Claude Code CLI (npm i -g @anthropic-ai/claude-code)…'),
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
      ...npmInstallWithDiagnosis('@openai/codex', 'Step 1/2  Installing OpenAI Codex CLI (npm i -g @openai/codex)…'),
      'echo; echo "Step 2/2  Signing in to OpenAI Codex…"',
      'codex login',
      'echo; echo "✓ Done. Go back to Métis and click \\"Connect\\" again."',
      'echo "You can close this window."'
    ]
  } else {
    return { ok: false, error: `setupCli: unknown provider '${provider}'` }
  }

  try {
    // cmd.exe needs CRLF: an LF-only .cmd misparses multi-line `if errorlevel 1 ( … )` blocks and
    // silently drops trailing commands. Bash is fine with LF, so only the Windows path changes.
    const eol = isWin ? '\r\n' : '\n'
    const script = scriptLines.join(eol) + eol
    const scriptPath = join(app.getPath('temp'), `asktoto-${provider}-setup-${randomBytes(8).toString('hex')}.${isWin ? 'cmd' : 'command'}`)
    writeFileSync(scriptPath, script, { mode: 0o755, flag: 'wx' })
    const err = await shell.openPath(scriptPath)
    if (err) return { ok: false, error: err }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * What to tell a user whose global npm install just failed — and, more importantly, what NOT to tell them.
 *
 * This block used to say `Try: sudo npm i -g <pkg>`. That advice is worse than useless: it is the most
 * common CAUSE of the failure it claims to fix. Reported from a real install (2026-08-24):
 *
 *     npm error code EEXIST
 *     npm error Invalid response body while trying to fetch …/eventsource-parser:
 *       EACCES: permission denied, mkdir '/Users/<user>/.npm/_cacache/content-v2/sha512/79/da'
 *
 * Read the path. That is the user's OWN cache under $HOME — not a system directory. It is unwritable
 * because an earlier `sudo npm …` created part of it as root. Every further sudo run roots a few more
 * files, so the advice deepened the exact hole the user was standing in, and left their npm permanently
 * broken for ordinary use. npm's own documentation says not to sudo global installs for this reason.
 *
 * So the two failures are told apart by where the unwritable path is, because they have opposite fixes:
 *   - under $HOME/.npm → the cache is root-owned. Chown it back, once, and never sudo npm again.
 *   - anywhere else → the global prefix is not writable. Point npm at a prefix the user owns, which is
 *     the durable fix rather than escalating privileges for every future install.
 *
 * `set -o pipefail` matters here: the install is piped to tee so the log can be inspected, and without it
 * the `if` would read tee's exit status and treat every failure as a success.
 */
export function npmInstallWithDiagnosis(pkg: string, step: string): string[] {
  return [
    'set -o pipefail',
    'NPM_LOG="$(mktemp -t metis-npm 2>/dev/null || mktemp)"',
    `echo "${step}"`,
    `if ! npm i -g ${pkg} 2>&1 | tee "$NPM_LOG"; then`,
    '  echo',
    '  if grep -qE "(EACCES|EEXIST|EPERM).*(\.npm/_cacache|\.npm/)" "$NPM_LOG" || grep -q "_cacache" "$NPM_LOG"; then',
    '    echo "✗ Install failed — your npm cache is owned by root, not by you."',
    '    echo',
    '    echo "  This is what a previous \"sudo npm …\" leaves behind. Running sudo again would root a few"',
    '    echo "  more files and make it harder to undo, so do NOT do that."',
    '    echo',
    '    echo "  Hand the cache back to yourself — once:"',
    '    echo "      sudo chown -R \$(id -u):\$(id -g) \"$HOME/.npm\""',
    '    echo',
    '    echo "  Then run this again WITHOUT sudo."',
    '  else',
    '    echo "✗ Install failed — npm could not write to its global folder."',
    '    echo',
    '    echo "  Rather than installing as root, give npm a folder you own:"',
    '    echo "      mkdir -p \"$HOME/.npm-global\""',
    '    echo "      npm config set prefix \"$HOME/.npm-global\""',
    '    echo "      then add this line to ~/.zshrc:  export PATH=\$HOME/.npm-global/bin:\$PATH"',
    '    echo',
    '    echo "  Open a new terminal, then run this again."',
    '  fi',
    '  echo "  Full log: $NPM_LOG"',
    '  echo; echo "Press any key to close."; read -n 1 -s; exit 1',
    'fi'
  ]
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
/** One-click self-contained install (cli-installer.ts): downloads the CLI package straight from the
 *  npm registry and runs it on Electron's embedded Node — the user needs NO Node.js, NO npm, nothing.
 *  Progress (with percent + ETA) is rendered through the same line stream the npm path uses, so the
 *  existing Settings/onboarding UI shows it without any renderer change. */
async function managedInstall(
  provider: ProviderId,
  onProgress: (line: string) => void
): Promise<CliInstallResult> {
  const id = provider === 'claude-cli' ? ('claude' as const) : provider === 'codex-cli' ? ('codex' as const) : null
  if (!id) return { ok: false, error: 'No installer for this provider.' }
  try {
    const result = await installManagedCli(id, (p) => {
      if (p.phase === 'downloading' && p.totalBytes) {
        const pct = Math.floor(((p.receivedBytes ?? 0) / p.totalBytes) * 100)
        const eta = p.etaMs != null ? ` — about ${Math.max(1, Math.round(p.etaMs / 1000))}s left` : ''
        onProgress(`Downloading… ${pct}%${eta}`)
      } else if (p.phase === 'resolving') onProgress('Finding the latest version…')
      else if (p.phase === 'verifying') onProgress('Verifying download integrity…')
      else if (p.phase === 'extracting') onProgress('Installing…')
    })
    onProgress(`Installed v${result.version} (self-contained — no Node.js required).`)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

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

  // No system npm → skip the shell entirely and self-install on Electron's embedded Node. This is the
  // one-click path for machines without a dev toolchain — the old behavior told the user to go install
  // Node from nodejs.org, which is exactly the onboarding wall this removes.
  if ((await resolveBin('npm')) === null) {
    return managedInstall(provider, onProgress)
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
        ? spawn(comSpecExe(), ['/d', '/s', '/c', 'npm', 'i', '-g', pkg], {
            env: process.env,
            shell: false,
            // Avoid a flashing console window for the cmd.exe install step.
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
        // npm existed at probe time but vanished/misfired — self-contained install instead of telling
        // the user to go install Node.
        void managedInstall(provider, onProgress).then(resolve)
        return
      }
      // Permission error: the global npm prefix needs admin. The managed install needs NO permissions
      // (it lives in userData) — try it before surfacing the Terminal fallback.
      if (INSTALL_PERMISSION_ERROR_RE.test(stderrText)) {
        onProgress('Global npm install needs admin — switching to the self-contained install…')
        void managedInstall(provider, onProgress).then((res) =>
          resolve(res.ok ? res : { ok: false, needsTerminal: true, error: 'Global install needs admin permission.' })
        )
        return
      }
      const tail = stderrText.slice(-300) || `Install failed (exit ${code}).`
      // Any other npm failure: the self-contained path is independent of whatever broke npm — last try.
      void managedInstall(provider, onProgress).then((res) => resolve(res.ok ? res : { ok: false, error: tail }))
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

  // Plain ASCII only in the batch body — the console codepage mangles accents (see setupCli).
  if (isWin) {
    if (provider === 'claude-cli') {
      scriptLines = [
        '@echo off',
        'cls',
        'echo Metis - Claude Code CLI login',
        'echo ================================',
        'echo.',
        'echo Type /login at the prompt below and follow the instructions.',
        'echo ----------------------------------------',
        'call claude',
        'echo.',
        'echo Done. Go back to Metis and click Connect again.',
        'pause'
      ]
    } else if (provider === 'codex-cli') {
      scriptLines = [
        '@echo off',
        'cls',
        'echo Metis - OpenAI Codex CLI login',
        'echo =================================',
        'echo.',
        'echo Follow the instructions below to sign in.',
        'echo ----------------------------------------',
        'call codex login',
        'echo.',
        'echo Done. Go back to Metis and click Connect again.',
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
    // CRLF for cmd.exe (see setupCli) — LF-only batch files misparse; POSIX keeps LF.
    const eol = isWin ? '\r\n' : '\n'
    const script = scriptLines.join(eol) + eol
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
