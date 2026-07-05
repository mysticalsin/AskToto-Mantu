import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Shared, hoisted mock for the promisified execFile so resolveBin can be driven without a real shell.
const h = vi.hoisted(() => ({ execFileImpl: vi.fn() }))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  shell: { openPath: vi.fn() }
}))

vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  // execFileAsync = promisify(execFile); wiring the custom symbol lets us resolve {stdout} deterministically.
  const execFile: unknown = vi.fn()
  ;(execFile as Record<symbol, unknown>)[promisify.custom] = h.execFileImpl
  const spawn = vi.fn(() => ({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn()
  }))
  return { execFile, spawn }
})

import { CLI_CONFIGS, cliEnv, resolveBin, idleWatchdog, runCliStream } from './cli'

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
  })

  it('claude-cli sends the prompt via stdin (never argv) and omits model/system flags when empty', () => {
    const args = CLI_CONFIGS['claude-cli']!.buildArgs({ model: '', system: '', prompt: 'hello' })
    expect(args[0]).toBe('-p') // print/non-interactive mode; the prompt is read from stdin
    expect(args).not.toContain('hello') // confidential content must NEVER appear in argv (ps-visible)
    expect(args).not.toContain('--model')
    expect(args).not.toContain('--append-system-prompt')
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
  // This suite exercises the mac/Linux login-shell branch (`sh -lc 'command -v <bin>'`) — pin the
  // platform so it's deterministic when the test runner itself is Windows. Mirrors the setPlatform
  // pattern in cli-win.test.ts, which pins 'win32' for the `where`/APPDATA branch's own suite.
  const REAL_PLATFORM = process.platform
  beforeEach(() => {
    h.execFileImpl.mockReset()
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true })
  })

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
