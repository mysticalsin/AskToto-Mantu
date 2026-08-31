import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

// Shared, hoisted mock for the promisified execFile so resolveBin can be driven without a real shell.
// spawnImpl is a controllable-per-test spawn mock (mirrors cli-win.test.ts), needed for the
// kill-on-result tests below — every other test in this file fails before reaching spawn.
const h = vi.hoisted(() => ({ execFileImpl: vi.fn(), spawnImpl: vi.fn() }))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  shell: { openPath: vi.fn() }
}))

// The sandbox temp dir (codex-cli's throwaway cwd) is driven through this mock rather than the real
// filesystem: the abort/cleanup ordering tests below need a deterministic point to observe
// ("mkdtemp resolved, spawn not yet reached") and an assertable rm, and concurrent agents share %TEMP%.
const fsp = vi.hoisted(() => ({ mkdtemp: vi.fn(), rm: vi.fn() }))
vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>()
  return { ...actual, mkdtemp: fsp.mkdtemp, rm: fsp.rm }
})

vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  // execFileAsync = promisify(execFile); wiring the custom symbol lets us resolve {stdout} deterministically.
  const execFile: unknown = vi.fn()
  ;(execFile as Record<symbol, unknown>)[promisify.custom] = h.execFileImpl
  h.spawnImpl.mockImplementation(() => ({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn()
  }))
  return { execFile, spawn: h.spawnImpl }
})

import { CLI_CONFIGS, checkCliSession, classifyCliStatusOutput, connectCliSession, cliEnv, resolveBin, idleWatchdog, runCliStream, testCli,
  clearBinCache, posixUserBinCandidates
} from './cli'

/**
 * MQA-251 — a test must not leak work into the next one.
 *
 * runCliStream returns `{ abort }` and does its work asynchronously. Several tests below fired it and
 * discarded the handle, so an in-flight resolveBin could still reach spawn AFTER the next test's
 * beforeEach had run mockReset() — landing the PREVIOUS test's call at `calls[0]` of the next one, under
 * the previous test's stubbed platform. That is why these tests passed when run alone and failed beside
 * their siblings, and why one full-suite run reported 0 failures and the next reported 5.
 *
 * It looked like an AbortSignal race in production code. It was a leak in the tests. Aborting every
 * started stream removes the overlap outright, rather than making the assertions tolerant of it — a
 * tolerant assertion would have buried this instead of surfacing it.
 */
let liveStream: { abort: () => void } | undefined
afterEach(() => {
  try {
    liveStream?.abort()
  } catch {
    /* already settled */
  }
  liveStream = undefined
})

/** Drain pending microtasks + one macrotask turn. setImmediate is deliberately left un-faked by the
 *  fake-timer blocks below, so this advances the stream/readline plumbing without moving the clock. */
async function tick(turns = 3): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** A fake ChildProcess: real Readable streams (so readline's createInterface behaves exactly as it
 *  does against a real spawn) wrapped in a real EventEmitter. Mirrors cli-win.test.ts's fakeChild. */
function fakeChild(): {
  child: EventEmitter & { stdin: { on: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }; stdout: PassThrough; stderr: PassThrough; pid: number; kill: ReturnType<typeof vi.fn> }
  stdout: PassThrough
  stderr: PassThrough
} {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
    stdin: { on: vi.fn(), write: vi.fn(), end: vi.fn() },
    stdout,
    stderr,
    pid: 4242,
    kill: vi.fn()
  })
  return { child, stdout, stderr }
}

describe('CLI_CONFIGS — security-critical arg arrays (must never relax)', () => {
  it('claude-cli locks tools fully down: --allowedTools "" and --disallowedTools "*", single turn', () => {
    const args = CLI_CONFIGS['claude-cli']!.buildArgs({ model: 'opus', system: 'sys', prompt: 'hi' })
    const ai = args.indexOf('--allowedTools')
    expect(ai).toBeGreaterThan(-1)
    expect(args[ai + 1]).toBe('') // no tools allowed
    const di = args.indexOf('--disallowedTools')
    expect(di).toBeGreaterThan(-1)
    expect(args[di + 1]).toBe('*') // every tool blocked
    expect(args[args.indexOf('--max-turns') + 1]).toBe('1')
    expect(args).toContain('stream-json')
    expect(args[args.indexOf('--model') + 1]).toBe('opus') // a real model passes through unchanged
  })

  it('claude-cli sends the prompt via stdin (never argv) and floors an empty model to "sonnet"', () => {
    const args = CLI_CONFIGS['claude-cli']!.buildArgs({ model: '', system: '', prompt: 'hello' })
    expect(args[0]).toBe('-p') // print/non-interactive mode; the prompt is read from stdin
    expect(args).not.toContain('hello') // confidential content must NEVER appear in argv (ps-visible)
    expect(args).not.toContain('--append-system-prompt')
    // cheap-by-default invariant: an empty model must never silently inherit the user's own CLI default
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet')
    // even with no model/system the lockdown flags are still present
    expect(args).toContain('--allowedTools')
    expect(args).toContain('--disallowedTools')
  })

  it('codex-cli disables the shell tool, skips git checks, sandboxes via exec, and keeps content off argv', () => {
    const args = CLI_CONFIGS['codex-cli']!.buildArgs({ model: 'gpt', system: 'sys', prompt: 'hi' })
    expect(args[0]).toBe('exec')
    expect(args).toContain('--json')
    expect(args).toContain('--skip-git-repo-check')
    expect(args).toContain('features.shell_tool=false')
    expect(args).not.toContain('developer_instructions=sys') // system goes via stdin, not argv
    expect(args.join(' ')).not.toContain('hi') // prompt must not appear in argv
    expect(args[args.indexOf('-m') + 1]).toBe('gpt')
  })

  it('codex-cli marks useTmpCwd so it never runs in the user project; claude-cli does not', () => {
    expect(CLI_CONFIGS['codex-cli']!.useTmpCwd).toBe(true)
    expect(CLI_CONFIGS['claude-cli']!.useTmpCwd).toBe(false)
  })
})

describe('parseLine — only emits real answer tokens', () => {
  it('claude-cli extracts text_delta text and ignores everything else', () => {
    const cfg = CLI_CONFIGS['claude-cli']!
    const ev = { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'hi' } } }
    expect(cfg.parseLine(JSON.stringify(ev))).toBe('hi')
    expect(cfg.parseLine(JSON.stringify({ type: 'stream_event', event: { delta: { type: 'input_json_delta' } } }))).toBeNull()
    expect(cfg.parseLine('not json at all')).toBeNull()
  })

  it('codex-cli extracts agent_message text and ignores other item types', () => {
    const cfg = CLI_CONFIGS['codex-cli']!
    const ev = { type: 'item.completed', item: { type: 'agent_message', text: 'done' } }
    expect(cfg.parseLine(JSON.stringify(ev))).toBe('done')
    expect(cfg.parseLine(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning' } }))).toBeNull()
    expect(cfg.parseLine('garbage')).toBeNull()
  })
})

describe('cliEnv — strips session/proxy vars so the spawned CLI runs clean', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it('claude-cli removes CLAUDE_CODE*/CLAUDECODE/agent-sdk + ANTHROPIC_BASE_URL but keeps unrelated vars', () => {
    process.env.CLAUDE_CODE_SESSION = 'x'
    process.env.CLAUDECODE = '1'
    process.env.CLAUDE_AGENT_SDK_VERSION = '1.2'
    process.env.ANTHROPIC_BASE_URL = 'http://proxy'
    process.env.ASKTOTO_KEEP_ME = 'keep'
    const env = cliEnv('claude-cli')
    expect(env.CLAUDE_CODE_SESSION).toBeUndefined()
    expect(env.CLAUDECODE).toBeUndefined()
    expect(env.CLAUDE_AGENT_SDK_VERSION).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env.ASKTOTO_KEEP_ME).toBe('keep')
  })

  it('codex-cli removes OPENAI_BASE_URL only (keeps the API key var)', () => {
    process.env.OPENAI_BASE_URL = 'http://proxy'
    process.env.OPENAI_API_KEY = 'sk-keepme'
    const env = cliEnv('codex-cli')
    expect(env.OPENAI_BASE_URL).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBe('sk-keepme')
  })
})

describe('resolveBin — login-shell lookup with in-process caching', () => {
  // These cases stub POSIX-style absolute paths (/usr/local/bin/…). resolveBin's win32 branch parses
  // `where` output and only accepts .cmd/.exe hits, so on a Windows host it would reject the stub and
  // fall through to null. Pin a POSIX platform so the lookup is host-independent.
  const REAL_PLATFORM = process.platform
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    clearBinCache()
    h.execFileImpl.mockReset()
  })
  afterEach(() => Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true }))

  it('resolves the absolute path and caches it (no second shell spawn)', async () => {
    h.execFileImpl.mockResolvedValue({ stdout: '/usr/local/bin/faketool-cache\n', stderr: '' })
    const a = await resolveBin('faketool-cache')
    const b = await resolveBin('faketool-cache')
    expect(a).toBe('/usr/local/bin/faketool-cache')
    expect(b).toBe('/usr/local/bin/faketool-cache')
    expect(h.execFileImpl).toHaveBeenCalledTimes(1) // second call served from cache
  })

  it('returns null when the shell resolves the binary to nothing', async () => {
    // `command -v <missing>` yields empty stdout → resolveBin maps that to null. (The reject→null branch is
    // exercised by the runCliStream contract test below.)
    h.execFileImpl.mockResolvedValue({ stdout: '   \n', stderr: '' })
    expect(await resolveBin('faketool-empty')).toBeNull()
  })
})

describe('idleWatchdog — aborts a stalled stream', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fires onIdle after the idle window with no ping', () => {
    const onIdle = vi.fn()
    const wd = idleWatchdog(onIdle)
    vi.advanceTimersByTime(120_000)
    expect(onIdle).toHaveBeenCalledTimes(1)
    wd.clear()
  })

  it('ping() resets the countdown', () => {
    const onIdle = vi.fn()
    const wd = idleWatchdog(onIdle)
    vi.advanceTimersByTime(119_000)
    wd.ping()
    vi.advanceTimersByTime(119_000)
    expect(onIdle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    expect(onIdle).toHaveBeenCalledTimes(1)
    wd.clear()
  })

  it('clear() prevents onIdle from ever firing', () => {
    const onIdle = vi.fn()
    const wd = idleWatchdog(onIdle)
    wd.clear()
    vi.advanceTimersByTime(240_000)
    expect(onIdle).not.toHaveBeenCalled()
  })
})

describe('runCliStream — contract', () => {
  it('returns an abort() handle synchronously (the stream runs async)', () => {
    h.execFileImpl.mockRejectedValue(new Error('not found')) // resolveBin → null → graceful onError
    const onError = vi.fn()
    const r = runCliStream({
      providerId: 'claude-cli',
      model: 'opus',
      system: '',
      prompt: 'hi',
      handlers: { onDelta: vi.fn(), onDone: vi.fn(), onError }
    })
    expect(typeof r.abort).toBe('function')
    r.abort() // clears the watchdog; no open handle left behind
  })
})

describe('isResultLine — claude-cli terminal marker (kill-on-result)', () => {
  it('matches a type:"result" line and rejects non-terminal stream_events/garbage', () => {
    const cfg = CLI_CONFIGS['claude-cli']!
    expect(cfg.isResultLine?.(JSON.stringify({ type: 'result', subtype: 'success' }))).toBe(true)
    expect(cfg.isResultLine?.(JSON.stringify({ type: 'stream_event', event: {} }))).toBe(false)
    expect(cfg.isResultLine?.(JSON.stringify({ type: 'stream_event', event: { type: 'text_delta', text: 'hi' } }))).toBe(false)
    expect(cfg.isResultLine?.('not json at all')).toBe(false)
  })

  it('matches message_stop — the marker that actually arrives when lingering hooks hold the result line back', () => {
    // Verified live 2026-08-05: with global Claude Code hooks installed, the type:'result' line is not
    // flushed until process teardown (~60-75s after the answer); message_stop arrives immediately after
    // the final text delta. --max-turns 1 + fully disallowed tools = exactly one assistant message per
    // run, so message_stop is end-of-answer for this invocation.
    const cfg = CLI_CONFIGS['claude-cli']!
    expect(
      cfg.isResultLine?.(JSON.stringify({ type: 'stream_event', event: { type: 'message_stop' }, session_id: 'x' }))
    ).toBe(true)
  })

  it('codex-cli has no isResultLine matcher — its terminal marker is unverified, left byte-identical', () => {
    expect(CLI_CONFIGS['codex-cli']!.isResultLine).toBeUndefined()
  })

  // MQA-020: is_error terminal lines were matched as success markers, so a CLI that died on a reached
  // subscription limit settled as a blank answer and the provider waterfall stopped there.
  it('MQA-020: an is_error result line is not a success marker, and its error text is recoverable', () => {
    const cfg = CLI_CONFIGS['claude-cli']!
    const limitReached = JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'Claude AI usage limit reached|1754000000'
    })
    expect(cfg.isResultLine?.(limitReached)).toBe(false)
    expect(cfg.errorResultLine?.(limitReached)).toBe('Claude AI usage limit reached|1754000000')
    // error_* subtype without the is_error flag is the same failed run
    expect(cfg.isResultLine?.(JSON.stringify({ type: 'result', subtype: 'error_max_turns' }))).toBe(false)
    expect(cfg.errorResultLine?.(JSON.stringify({ type: 'result', subtype: 'error_max_turns' }))).toBe('error_max_turns')
  })

  it('MQA-020: successful terminal markers are untouched — errorResultLine only fires on failures', () => {
    const cfg = CLI_CONFIGS['claude-cli']!
    expect(cfg.errorResultLine?.(JSON.stringify({ type: 'result', subtype: 'success' }))).toBeNull()
    expect(cfg.errorResultLine?.(JSON.stringify({ type: 'result' }))).toBeNull()
    expect(cfg.errorResultLine?.(JSON.stringify({ type: 'stream_event', event: { type: 'message_stop' } }))).toBeNull()
    expect(cfg.errorResultLine?.('not json at all')).toBeNull()
  })
})

describe('runCliStream — kill-on-result settles without waiting for child exit (claude-cli)', () => {
  // Pin darwin: resolveBin's win32 branch parses `where` output for a .cmd/.exe hit and would reject
  // this POSIX-style stub, making the test host-dependent (same rationale as the resolveBin block above).
  const REAL_PLATFORM = process.platform
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    clearBinCache()
    h.execFileImpl.mockReset()
    h.spawnImpl.mockReset()
  })
  afterEach(() => Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true }))

  it('a type:"result" line calls onDone and aborts the spawn signal immediately', async () => {
    h.execFileImpl.mockResolvedValue({ stdout: '/usr/local/bin/claude\n', stderr: '' })
    const { child, stdout } = fakeChild()
    h.spawnImpl.mockReturnValue(child)

    const onDone = vi.fn()
    const onError = vi.fn()
    liveStream = runCliStream({
      providerId: 'claude-cli',
      model: 'opus',
      system: '',
      prompt: 'hi',
      handlers: { onDelta: vi.fn(), onDone, onError }
    })

    await vi.waitFor(() => expect(h.spawnImpl).toHaveBeenCalled())
    const spawnOpts = h.spawnImpl.mock.calls[0][2] as { signal: AbortSignal }
    expect(spawnOpts.signal.aborted).toBe(false) // not yet — the result line hasn't arrived

    stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success' })}\n`)
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))

    expect(onDone).toHaveBeenCalledWith({})
    expect(onError).not.toHaveBeenCalled()
    // No 'close' was ever emitted on the child — onDone fired from the result line, not from process
    // exit — and the same signal spawn() was given is now aborted, which is what tears the child down
    // (reuses the existing abort-listener → killWindowsProcessTree plumbing).
    expect(spawnOpts.signal.aborted).toBe(true)
  })

  it('a late close after the result line does not double-settle onDone/onError', async () => {
    h.execFileImpl.mockResolvedValue({ stdout: '/usr/local/bin/claude\n', stderr: '' })
    const { child, stdout } = fakeChild()
    h.spawnImpl.mockReturnValue(child)

    const onDone = vi.fn()
    const onError = vi.fn()
    liveStream = runCliStream({
      providerId: 'claude-cli',
      model: 'opus',
      system: '',
      prompt: 'hi',
      handlers: { onDelta: vi.fn(), onDone, onError }
    })

    await vi.waitFor(() => expect(h.spawnImpl).toHaveBeenCalled())
    stdout.write(`${JSON.stringify({ type: 'result' })}\n`)
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))

    // Simulates the owner's global-hook linger: the child finally exits well after the result line.
    child.emit('close', 1)
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  // MQA-020: this is the CLI-as-failover-target path. A reached Claude subscription limit emits no text
  // deltas and one is_error result line; settling that as onDone blanked the answer panel and — because
  // index.ts only fails over from onError — silenced the rest of the provider waterfall.
  it('MQA-020: an is_error result line reports onError with the CLI cause, never a blank onDone', async () => {
    h.execFileImpl.mockResolvedValue({ stdout: '/usr/local/bin/claude\n', stderr: '' })
    const { child, stdout } = fakeChild()
    h.spawnImpl.mockReturnValue(child)

    const onDelta = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()
    liveStream = runCliStream({
      providerId: 'claude-cli',
      model: 'opus',
      system: '',
      prompt: 'hi',
      handlers: { onDelta, onDone, onError }
    })

    await vi.waitFor(() => expect(h.spawnImpl).toHaveBeenCalled())
    const spawnOpts = h.spawnImpl.mock.calls[0][2] as { signal: AbortSignal }
    stdout.write(
      `${JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'Claude AI usage limit reached|1754000000'
      })}\n`
    )

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    expect(onError.mock.calls[0][0]).toContain('Claude AI usage limit reached')
    expect(onError.mock.calls[0][0]).toContain('Claude Code') // the caller must see WHICH provider died
    expect(onDone).not.toHaveBeenCalled()
    expect(onDelta).not.toHaveBeenCalled()
    // Still torn down on the spot: a failed run must not be left running any longer than a good one.
    expect(spawnOpts.signal.aborted).toBe(true)

    // The non-zero exit that follows must not double-report on top of the error already surfaced.
    child.emit('close', 1)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onDone).not.toHaveBeenCalled()
  })
})

describe('runCliStream — Windows .cmd-shim teardown ordering', () => {
  // Pin win32 + an npm .cmd shim: that is the install shape where spawn() is given no signal, so the
  // abort listener registered after it is the ONLY teardown — the shape both defects live in.
  const REAL_PLATFORM = process.platform
  const TMP_CWD = 'C:\\Temp\\asktoto-cli-test'
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    clearBinCache()
    h.execFileImpl.mockReset()
    h.spawnImpl.mockReset()
    fsp.mkdtemp.mockReset()
    fsp.rm.mockReset()
    h.execFileImpl.mockResolvedValue({ stdout: 'C:\\npm\\codex.cmd\r\n', stderr: '' })
    fsp.mkdtemp.mockResolvedValue(TMP_CWD)
    fsp.rm.mockResolvedValue(undefined)
    // Neither test may reach spawn — but hand it a usable child anyway, so a regression reports as a
    // failed assertion below rather than as an unhandled TypeError on undefined.
    h.spawnImpl.mockReturnValue(fakeChild().child)
  })
  afterEach(() => Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true }))

  // MQA-050: an abort delivered before spawn() returns left the whole cmd.exe → codex tree running —
  // spawn got no signal on this path, and the listener that would have taskkill'd it was attached to
  // an already-aborted signal, which never fires. Stop did not stop, and the tree outlived the app.
  it('MQA-050: an abort landing before spawn() never starts a tree nothing can kill', async () => {
    const onError = vi.fn()
    const r = runCliStream({
      providerId: 'codex-cli',
      model: '',
      system: '',
      prompt: 'hi',
      handlers: { onDelta: vi.fn(), onDone: vi.fn(), onError }
    })
    // Stop / new chat / window close, delivered inside the resolveBin + mkdtemp await window — the
    // same window index.ts's askCancel hits on a cold bin cache, and on every codex ask.
    r.abort()

    await vi.waitFor(() => expect(fsp.mkdtemp).toHaveBeenCalled())
    await tick()

    expect(h.spawnImpl).not.toHaveBeenCalled()
    expect(fsp.rm).toHaveBeenCalledWith(TMP_CWD, { recursive: true, force: true })
    expect(onError).not.toHaveBeenCalled() // a user cancel is not a provider failure
  })

  // MQA-087: the sandbox cwd is created before the shim guard runs, and no child is ever spawned on a
  // rejection — so the 'close' handler that normally removes it can't run and %TEMP% collects one
  // asktoto-cli-* directory per failed ask.
  it('MQA-087: a shim-guard rejection removes the sandbox cwd and names the offending argument', async () => {
    const onError = vi.fn()
    liveStream = runCliStream({
      providerId: 'codex-cli',
      model: 'gpt-5-codex(preview)', // parens are cmd.exe metacharacters — cmdShimSpawn refuses this
      system: '',
      prompt: 'hi',
      handlers: { onDelta: vi.fn(), onDone: vi.fn(), onError }
    })

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1))

    expect(h.spawnImpl).not.toHaveBeenCalled()
    expect(fsp.rm).toHaveBeenCalledWith(TMP_CWD, { recursive: true, force: true })
    // The model id is the only free-text arg here; without naming it the user cannot tell what to fix.
    expect(onError.mock.calls[0][0]).toContain("value for '-m'")
  })
})

describe('runCliStream — the idle watchdog measures idle time, not total runtime', () => {
  const REAL_PLATFORM = process.platform
  const REASONING = JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'thinking' } })
  const ANSWER = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } })

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    // Fake ONLY the watchdog's own timer family — readline/PassThrough delivery keeps running on real
    // nextTick/setImmediate, so lines can be fed in between clock advances.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    clearBinCache()
    h.execFileImpl.mockReset()
    h.spawnImpl.mockReset()
    fsp.mkdtemp.mockReset()
    fsp.rm.mockReset()
    h.execFileImpl.mockResolvedValue({ stdout: 'C:\\npm\\codex.cmd\r\n', stderr: '' })
    fsp.mkdtemp.mockResolvedValue('C:\\Temp\\asktoto-cli-test')
    fsp.rm.mockResolvedValue(undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true })
  })

  // MQA-040: codex-cli's parseLine returns text only for the FINISHED answer, so the only ping site
  // was unreachable until the run was already over — the per-tier idle budget was in fact a hard
  // ceiling on the whole `codex exec` runtime, killing healthy runs at 15s (suggest) / 45s (base).
  it('MQA-040: codex progress lines reset the budget, so a long run is not killed mid-answer', async () => {
    const { child, stdout } = fakeChild()
    h.spawnImpl.mockReturnValue(child)
    const onDelta = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()
    liveStream = runCliStream({
      providerId: 'codex-cli',
      model: '',
      system: '',
      prompt: 'hi',
      idleMs: 45_000,
      handlers: { onDelta, onDone, onError }
    })
    await tick(6)
    expect(h.spawnImpl).toHaveBeenCalled()

    // 132s of a 45s budget, with the CLI reporting progress the whole way — the shape of a real
    // `codex exec` run, which reasons for far longer than it takes to emit the answer.
    for (let i = 0; i < 3; i++) {
      stdout.write(`${REASONING}\n`)
      await tick()
      vi.advanceTimersByTime(44_000)
    }
    expect(onError).not.toHaveBeenCalled()
    expect(onDelta).not.toHaveBeenCalled() // a reasoning item is still not answer text

    stdout.write(`${ANSWER}\n`)
    await tick()
    expect(onDelta).toHaveBeenCalledWith('done')
  })

  // The other half of the contract: pinging on PROTOCOL lines only, so a hung child — or one whose
  // lingering hooks keep logging free text — is still aborted and can still fail over.
  it('MQA-040: free-text chatter does not ping, so a hung CLI still times out', async () => {
    const { child, stdout } = fakeChild()
    h.spawnImpl.mockReturnValue(child)
    const onError = vi.fn()
    liveStream = runCliStream({
      providerId: 'codex-cli',
      model: '',
      system: '',
      prompt: 'hi',
      idleMs: 45_000,
      handlers: { onDelta: vi.fn(), onDone: vi.fn(), onError }
    })
    await tick(6)
    expect(h.spawnImpl).toHaveBeenCalled()

    stdout.write('still working on it\n')
    await tick()
    vi.advanceTimersByTime(45_000)

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toContain('timed out')
  })
})

describe('testCli — the connection probe spawns under the same lockdown as a real ask', () => {
  const REAL_PLATFORM = process.platform
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    clearBinCache()
    h.execFileImpl.mockReset()
    h.spawnImpl.mockReset()
    fsp.mkdtemp.mockReset()
    fsp.rm.mockReset()
    h.execFileImpl.mockResolvedValue({ stdout: '/usr/local/bin/claude\n', stderr: '' })
    fsp.rm.mockResolvedValue(undefined)
  })
  afterEach(() => Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true }))

  // MQA-086: the probe hits the same live CLI login as a real ask. Without the deny list the user's
  // own auto-approved tools were live for that turn (the allow list is additive over settings.json),
  // and without --model the turn billed — and reported "connected" for — their premium CLI default.
  it('MQA-086: the claude-cli probe blocks every tool and pins the model it actually asks with', async () => {
    const { child, stdout } = fakeChild()
    h.spawnImpl.mockReturnValue(child)

    const p = testCli('claude-cli')
    await vi.waitFor(() => expect(h.spawnImpl).toHaveBeenCalled())

    const args = h.spawnImpl.mock.calls[0][1] as string[]
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('')
    const di = args.indexOf('--disallowedTools')
    expect(di).toBeGreaterThan(-1)
    expect(args[di + 1]).toBe('*')
    const mi = args.indexOf('--model')
    expect(mi).toBeGreaterThan(-1)
    expect(args[mi + 1]).toBe('sonnet') // the interactive ask is pinned to Sonnet — test what ships
    expect(args).not.toContain('Reply with OK') // the probe prompt still goes via stdin, not argv

    stdout.write('OK')
    await tick()
    child.emit('close', 0)
    await expect(p).resolves.toEqual({ ok: true })
  })

  // MQA-086: the codex probe used to swallow a mkdtemp failure and run in the app's own cwd, dropping
  // the "throwaway tmp cwd" half of the file's security invariant.
  it('MQA-086: the codex-cli probe fails when the sandbox cwd cannot be created, never falling back to the app cwd', async () => {
    h.execFileImpl.mockResolvedValue({ stdout: '/usr/local/bin/codex\n', stderr: '' })
    fsp.mkdtemp.mockRejectedValue(new Error('ENOENT'))

    const res = await testCli('codex-cli')

    expect(h.spawnImpl).not.toHaveBeenCalled()
    expect(res.ok).toBe(false)
    expect(res.error).toContain('sandbox working directory')
  })
})


// MQA-062 — `cliConnected` was write-once, so a `claude logout` in a terminal left the app asserting a
// provider it could no longer use. The ask path retires the flag on a credential rejection, but only
// AFTER the user has asked something and watched it fail; this probe is what lets startup and the
// Settings panel find out first. It must be cheap (no billed turn) and, above all, must never retire a
// live connection on ambiguous evidence.
describe('checkCliSession — the zero-token liveness probe behind MQA-062', () => {
  const REAL_PLATFORM = process.platform
  // A FRESH copy of cli.ts per case: resolveBin caches positive hits in a module-level map, and the
  // testCli suite above has already warmed 'claude'/'codex' — without this, the missing-binary case
  // below could never be reached.
  let checkCliSession: typeof import('./cli').checkCliSession

  /** Route resolveBin (`$SHELL -lc "command -v <bin>"`) and the status probe to separate fakes. */
  const wire = (status: () => Promise<{ stdout: string }>, bin: string | null = '/usr/local/bin/tool'): void => {
    h.execFileImpl.mockImplementation((_cmd: string, args: string[]) => {
      if (args?.[0] === '-lc') return Promise.resolve({ stdout: bin ? `${bin}\n` : '   \n', stderr: '' })
      if (args?.[0] === 'auth' || args?.[0] === 'login') return status()
      return Promise.reject(new Error(`unexpected execFile args: ${JSON.stringify(args)}`))
    })
  }

  beforeEach(async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    clearBinCache()
    h.execFileImpl.mockReset()
    vi.resetModules()
    checkCliSession = (await import('./cli')).checkCliSession
  })
  afterEach(() => Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true }))

  it('asks the status subcommand, never a billed completion', async () => {
    wire(async () => ({ stdout: JSON.stringify({ loggedIn: true }) }))
    expect(await checkCliSession('claude-cli')).toBe('live')
    const probe = h.execFileImpl.mock.calls.find((c) => (c[1] as string[])?.[0] === 'auth')
    expect(probe?.[1]).toEqual(['auth', 'status'])
    // The lockdown args a real ask / testCli carries would mean a spawned model turn — nothing here runs one.
    expect(JSON.stringify(h.execFileImpl.mock.calls)).not.toContain('--disallowedTools')
    expect(h.spawnImpl).not.toHaveBeenCalled()
  })

  it("reads claude's JSON verdict in both directions", async () => {
    wire(async () => ({ stdout: JSON.stringify({ loggedIn: false, authMethod: null }) }))
    expect(await checkCliSession('claude-cli')).toBe('signed-out')
  })

  it("reads codex's line, and 'Not logged in' never matches the positive pattern", async () => {
    wire(async () => ({ stdout: 'Logged in using ChatGPT\n' }))
    expect(await checkCliSession('codex-cli')).toBe('live')
  })

  it('reads a codex negative as signed out', async () => {
    wire(async () => ({ stdout: 'Not logged in\n' }))
    expect(await checkCliSession('codex-cli')).toBe('signed-out')
  })

  it('treats a missing binary as missing — not signed-out, so Settings can say not installed', async () => {
    wire(async () => ({ stdout: '' }), null)
    expect(await checkCliSession('claude-cli')).toBe('missing')
    // Confirmed absent means BOTH lookups answered null, not one.
    expect(h.execFileImpl.mock.calls.filter((c) => (c[1] as string[])?.[0] === '-lc')).toHaveLength(2)
  })

  it('reads a signed-in Claude weekly cap as weekly-limit, not signed-out', async () => {
    wire(async () => ({
      stdout: JSON.stringify({ loggedIn: true }),
      stderr: 'weekly limit reached, resets Sep 4 3pm America/Toronto'
    }))
    expect(await checkCliSession('claude-cli')).toBe('weekly-limit')
  })

  it('reads a signed-in Codex weekly cap as weekly-limit, not signed-out', async () => {
    wire(async () => ({ stdout: 'Logged in using ChatGPT\nYou have reached your weekly limit.\n' }))
    expect(await checkCliSession('codex-cli')).toBe('weekly-limit')
  })

  it('reads Codex logged-in text on stderr even when the process exits non-zero', async () => {
    wire(async () =>
      Promise.reject(Object.assign(new Error('exited 1'), { stdout: '', stderr: 'Logged in using ChatGPT\n' }))
    )
    expect(await checkCliSession('codex-cli')).toBe('live')
  })

  it('does not retire a working CLI on a transient lookup failure', async () => {
    // resolveBin shells out to the login shell on mac/Linux and caches only positive hits, so a hiccup
    // on the first call is indistinguishable from an uninstall until the second one answers.
    let lookups = 0
    h.execFileImpl.mockImplementation((_cmd: string, args: string[]) => {
      if (args?.[0] === '-lc') {
        lookups += 1
        return Promise.resolve({ stdout: lookups === 1 ? '   \n' : '/usr/local/bin/tool\n', stderr: '' })
      }
      if (args?.[0] === 'auth') return Promise.resolve({ stdout: JSON.stringify({ loggedIn: true }) })
      return Promise.reject(new Error(`unexpected execFile args: ${JSON.stringify(args)}`))
    })
    expect(await checkCliSession('claude-cli')).toBe('live')
    expect(lookups).toBe(2)
  })

  // The safety property, and the reason the verdict is three-valued: a false "signed out" retires a
  // working connection and sends the user off to reconnect for nothing, so anything this probe cannot
  // read confidently must change nothing.
  it('answers unknown on an output shape it does not recognise', async () => {
    wire(async () => ({ stdout: 'usage: claude auth [options]' }))
    expect(await checkCliSession('claude-cli')).toBe('unknown')
  })

  it('answers unknown when claude fails to run — it reports its verdict in JSON, not in the exit code', async () => {
    wire(async () => Promise.reject(new Error('command not found')))
    expect(await checkCliSession('claude-cli')).toBe('unknown')
  })

  it('answers unknown on a timeout, for either CLI', async () => {
    wire(async () => Promise.reject(Object.assign(new Error('timed out'), { killed: true })))
    expect(await checkCliSession('codex-cli')).toBe('unknown')
  })

  it('answers unknown on codex output that states nothing either way', async () => {
    wire(async () => ({ stdout: 'something else entirely' }))
    expect(await checkCliSession('codex-cli')).toBe('unknown')
  })

  it('scrubs the API-key env so a keyed environment cannot mask a logged-out CLI', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-should-not-leak')
    wire(async () => ({ stdout: JSON.stringify({ loggedIn: true }) }))
    await checkCliSession('claude-cli')
    const probe = h.execFileImpl.mock.calls.find((c) => (c[1] as string[])?.[0] === 'auth')
    const env = (probe?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env
    expect(env?.ANTHROPIC_API_KEY).toBeUndefined()
    vi.unstubAllEnvs()
  })
})

describe('classifyCliStatusOutput — weekly-limit vs signed-out vs live', () => {
  it('claude: loggedIn true is live; false is signed-out; weekly banner on a login is weekly-limit', () => {
    expect(classifyCliStatusOutput('claude-cli', JSON.stringify({ loggedIn: true }), '')).toBe('live')
    expect(classifyCliStatusOutput('claude-cli', JSON.stringify({ loggedIn: false }), '')).toBe('signed-out')
    expect(
      classifyCliStatusOutput(
        'claude-cli',
        JSON.stringify({ loggedIn: true }),
        'weekly limit reached, resets Sep 4'
      )
    ).toBe('weekly-limit')
  })

  it('codex: Logged in is live; Not logged in is signed-out; weekly + logged in is weekly-limit', () => {
    expect(classifyCliStatusOutput('codex-cli', 'Logged in using ChatGPT\n', '')).toBe('live')
    expect(classifyCliStatusOutput('codex-cli', 'Not logged in\n', '')).toBe('signed-out')
    expect(
      classifyCliStatusOutput('codex-cli', 'Logged in using ChatGPT\nweekly usage limit reached\n', '')
    ).toBe('weekly-limit')
  })
})

describe('connectCliSession — Settings Connect never auto-sends a billed turn', () => {
  const REAL_PLATFORM = process.platform
  let connectCliSessionFn: typeof connectCliSession

  beforeEach(async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    clearBinCache()
    h.execFileImpl.mockReset()
    h.spawnImpl.mockClear()
    vi.resetModules()
    connectCliSessionFn = (await import('./cli')).connectCliSession
  })
  afterEach(() => Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true }))

  it('marks a weekly-capped Claude session connected without spawning a prompt', async () => {
    h.execFileImpl.mockImplementation((_cmd: string, args: string[]) => {
      if (args?.[0] === '-lc') return Promise.resolve({ stdout: '/usr/local/bin/claude\n', stderr: '' })
      if (args?.[0] === 'auth') {
        return Promise.resolve({
          stdout: JSON.stringify({ loggedIn: true }),
          stderr: 'weekly limit reached'
        })
      }
      if (args?.[0] === '--version') return Promise.resolve({ stdout: '2.1.251\n', stderr: '' })
      return Promise.reject(new Error(`unexpected execFile args: ${JSON.stringify(args)}`))
    })
    const r = await connectCliSessionFn('claude-cli')
    expect(r.ok).toBe(true)
    expect(r.session).toBe('weekly-limit')
    expect(r.error).toMatch(/weekly/i)
    expect(h.spawnImpl).not.toHaveBeenCalled()
    expect(JSON.stringify(h.execFileImpl.mock.calls)).not.toContain('--disallowedTools')
  })

  it('marks a logged-in Codex session connected without spawning exec', async () => {
    h.execFileImpl.mockImplementation((_cmd: string, args: string[]) => {
      if (args?.[0] === '-lc') return Promise.resolve({ stdout: '/usr/local/bin/codex\n', stderr: '' })
      if (args?.[0] === 'login') return Promise.resolve({ stdout: 'Logged in using ChatGPT\n', stderr: '' })
      if (args?.[0] === '--version') return Promise.resolve({ stdout: '0.144.5\n', stderr: '' })
      return Promise.reject(new Error(`unexpected execFile args: ${JSON.stringify(args)}`))
    })
    const r = await connectCliSessionFn('codex-cli')
    expect(r.ok).toBe(true)
    expect(r.session).toBe('live')
    expect(h.spawnImpl).not.toHaveBeenCalled()
  })
})

describe('posixUserBinCandidates', () => {
  it('points at ~/.local/bin and ~/.hermes/node/bin for GUI PATH gaps', () => {
    const prev = process.env.HOME
    process.env.HOME = '/Users/tony'
    expect(posixUserBinCandidates('claude')).toEqual([
      '/Users/tony/.local/bin/claude',
      '/Users/tony/.hermes/node/bin/claude'
    ])
    process.env.HOME = prev
  })
})
