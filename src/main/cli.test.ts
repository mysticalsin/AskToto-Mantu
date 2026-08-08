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

import { CLI_CONFIGS, cliEnv, resolveBin, idleWatchdog, runCliStream } from './cli'

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
    runCliStream({
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
    runCliStream({
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
    runCliStream({
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
