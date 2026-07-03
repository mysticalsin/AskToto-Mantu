/**
 * notebooklm.test.ts — unit tests with the MCP SDK mocked (per the build brief: do NOT stand up a
 * real listening server here, unlike bidstackClient.test.ts's Streamable HTTP mock — a stdio
 * transport spawns a child process rather than opening a TCP listener, but this suite still follows
 * the brief and drives notebooklm.ts entirely through a mocked `Client`/`StdioClientTransport`).
 *
 * Covers: binary resolution / install / detect against a mocked node:child_process, then
 * connect/ask arg-shaping, result-shaping, sign-in classification, and timeout behavior against a
 * mocked SDK Client whose connect()/callTool() respect the real AbortSignal notebooklm.ts creates —
 * so the timeout assertions exercise notebooklm.ts's actual timer/AbortController wiring, not a
 * fake stand-in for it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

const h = vi.hoisted(() => ({
  execFileImpl: vi.fn(),
  spawnImpl: vi.fn(),
  ClientCtor: vi.fn(),
  StdioTransportCtor: vi.fn(),
  clientConnect: vi.fn(),
  clientListTools: vi.fn(),
  clientCallTool: vi.fn(),
  clientClose: vi.fn()
}))

vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  // execFileAsync = promisify(execFile); wiring the custom symbol lets us resolve {stdout} deterministically
  // (same trick main/cli.test.ts uses for resolveBin).
  const execFile: unknown = vi.fn()
  ;(execFile as Record<symbol, unknown>)[promisify.custom] = h.execFileImpl
  return { execFile, spawn: h.spawnImpl }
})

vi.mock('../logger', () => ({ mainLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  // Regular `function`, not an arrow — notebooklm.ts calls `new Client(...)`, and an arrow function
  // has no [[Construct]] internal slot (`new` on one throws), which a vitest mock would otherwise
  // swallow as an opaque "not a constructor" TypeError deep inside withStdioClient.
  Client: h.ClientCtor.mockImplementation(function () {
    return {
      connect: h.clientConnect,
      listTools: h.clientListTools,
      callTool: h.clientCallTool,
      close: h.clientClose
    }
  })
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: h.StdioTransportCtor.mockImplementation(function (opts: unknown) {
    return { __opts: opts }
  })
}))

import {
  resolveBinary,
  detectNotebookLmCli,
  installNotebookLmCli,
  connectNotebookLm,
  askNotebookLm,
  __resetBinaryCacheForTests
} from './notebooklm'

/** A fake ChildProcess: real Readable streams (so `node:readline`'s createInterface behaves exactly
 *  as it does against a real spawn) wrapped in a real EventEmitter (so 'error'/'close' behave too). */
function fakeChild(): { child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> }; stdout: PassThrough; stderr: PassThrough } {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child = Object.assign(new EventEmitter(), { stdout, stderr, kill: vi.fn() })
  return { child, stdout, stderr }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

beforeEach(() => {
  __resetBinaryCacheForTests()
  h.execFileImpl.mockReset()
  h.spawnImpl.mockReset()
  h.ClientCtor.mockClear()
  h.StdioTransportCtor.mockClear()
  h.clientConnect.mockReset()
  h.clientListTools.mockReset()
  h.clientCallTool.mockReset()
  h.clientClose.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

// ─── resolveBinary ───────────────────────────────────────────────────────────────

describe('resolveBinary — login-shell lookup with in-process caching', () => {
  it('resolves an absolute path and caches it (no second shell spawn)', async () => {
    h.execFileImpl.mockResolvedValue({ stdout: '/usr/local/bin/faketool\n', stderr: '' })
    const a = await resolveBinary('faketool')
    const b = await resolveBinary('faketool')
    expect(a).toBe('/usr/local/bin/faketool')
    expect(b).toBe('/usr/local/bin/faketool')
    expect(h.execFileImpl).toHaveBeenCalledTimes(1)
  })

  it('returns null (uncached) when the shell finds nothing', async () => {
    h.execFileImpl.mockRejectedValue(new Error('command not found'))
    expect(await resolveBinary('missingtool')).toBeNull()
    expect(await resolveBinary('missingtool')).toBeNull()
    expect(h.execFileImpl).toHaveBeenCalledTimes(2) // a miss is never cached — a later install must be picked up
  })
})

// ─── detectNotebookLmCli ─────────────────────────────────────────────────────────

describe('detectNotebookLmCli', () => {
  it('reports not installed when `nlm` is not on PATH', async () => {
    h.execFileImpl.mockRejectedValue(new Error('command not found'))
    const r = await detectNotebookLmCli()
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not installed/i)
  })

  it('reports installed with a version when `nlm --version` succeeds', async () => {
    h.execFileImpl.mockImplementation(async (bin: string, args: string[]) => {
      if (args[0] === '-lc') return { stdout: '/usr/local/bin/nlm\n', stderr: '' }
      if (args[0] === '--version') return { stdout: 'nlm 0.2.0\n', stderr: '' }
      throw new Error('unexpected call')
    })
    const r = await detectNotebookLmCli()
    expect(r.ok).toBe(true)
    expect(r.version).toBe('nlm 0.2.0')
  })

  it('still reports installed when --version itself fails to run', async () => {
    h.execFileImpl.mockImplementation(async (bin: string, args: string[]) => {
      if (args[0] === '-lc') return { stdout: '/usr/local/bin/nlm\n', stderr: '' }
      throw new Error('--version not supported')
    })
    const r = await detectNotebookLmCli()
    expect(r.ok).toBe(true)
    expect(r.version).toBe('installed')
  })
})

// ─── installNotebookLmCli ──────────────────────────────────────────────────────────

describe('installNotebookLmCli', () => {
  it('short-circuits when nlm is already installed, without touching any package manager', async () => {
    h.execFileImpl.mockResolvedValue({ stdout: '/usr/local/bin/nlm\n', stderr: '' })
    const onProgress = vi.fn()
    const r = await installNotebookLmCli(onProgress)
    expect(r.ok).toBe(true)
    expect(onProgress).toHaveBeenCalledWith('Already installed.')
    expect(h.spawnImpl).not.toHaveBeenCalled()
  })

  it('fails friendlily when no package manager (uv/pipx/pip) is found', async () => {
    h.execFileImpl.mockRejectedValue(new Error('command not found')) // nlm AND every manager miss
    const r = await installNotebookLmCli(vi.fn())
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/uv/i)
    expect(h.spawnImpl).not.toHaveBeenCalled()
  })

  it('installs via uv, streams progress, and evicts the binary cache on success', async () => {
    h.execFileImpl.mockImplementation(async (_bin: string, args: string[]) => {
      const cmd = args[1] as string
      if (cmd.includes('command -v nlm')) throw new Error('not found')
      if (cmd.includes('command -v uv')) return { stdout: '/opt/homebrew/bin/uv\n', stderr: '' }
      throw new Error('not found')
    })
    const { child, stdout } = fakeChild()
    h.spawnImpl.mockReturnValue(child)

    const onProgress = vi.fn()
    const resultPromise = installNotebookLmCli(onProgress)
    stdout.write('Installed notebooklm-mcp-cli\n')
    await tick()
    child.emit('close', 0)

    const r = await resultPromise
    expect(r.ok).toBe(true)
    expect(onProgress).toHaveBeenCalledWith('Installed notebooklm-mcp-cli')
    // spawned via the login shell with the resolved uv path + fixed args, never shell:true
    const [, spawnArgs, spawnOpts] = h.spawnImpl.mock.calls[0]
    expect(spawnOpts.shell).toBe(false)
    expect(spawnArgs.join(' ')).toContain('tool')
    expect(spawnArgs.join(' ')).toContain('notebooklm-mcp-cli')

    // cache was evicted — a subsequent resolve re-probes instead of returning the earlier null
    h.execFileImpl.mockReset()
    h.execFileImpl.mockResolvedValue({ stdout: '/usr/local/bin/nlm\n', stderr: '' })
    expect(await resolveBinary('nlm')).toBe('/usr/local/bin/nlm')
  })

  it('classifies a permission failure as needsTerminal instead of a raw npm/pip dump', async () => {
    h.execFileImpl.mockImplementation(async (_bin: string, args: string[]) => {
      const cmd = args[1] as string
      if (cmd.includes('command -v nlm')) throw new Error('not found')
      if (cmd.includes('command -v uv')) return { stdout: '/opt/homebrew/bin/uv\n', stderr: '' }
      throw new Error('not found')
    })
    const { child, stderr } = fakeChild()
    h.spawnImpl.mockReturnValue(child)

    const resultPromise = installNotebookLmCli(vi.fn())
    stderr.write('EACCES: permission denied\n')
    await tick()
    child.emit('close', 1)

    const r = await resultPromise
    expect(r.ok).toBe(false)
    expect(r.needsTerminal).toBe(true)
  })

  it('kills the child and fails cleanly if the install runs past its timeout budget', async () => {
    vi.useFakeTimers()
    h.execFileImpl.mockImplementation(async (_bin: string, args: string[]) => {
      const cmd = args[1] as string
      if (cmd.includes('command -v nlm')) throw new Error('not found')
      if (cmd.includes('command -v uv')) return { stdout: '/opt/homebrew/bin/uv\n', stderr: '' }
      throw new Error('not found')
    })
    const { child } = fakeChild()
    h.spawnImpl.mockReturnValue(child)

    const resultPromise = installNotebookLmCli(vi.fn())
    await vi.advanceTimersByTimeAsync(200_000) // past INSTALL_TIMEOUT_MS; child never closes on its own
    const r = await resultPromise
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/timed out/i)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })
})

// ─── connectNotebookLm ─────────────────────────────────────────────────────────

describe('connectNotebookLm', () => {
  it('reports not-installed without ever constructing an SDK client', async () => {
    h.execFileImpl.mockRejectedValue(new Error('command not found'))
    const r = await connectNotebookLm()
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not installed/i)
    expect(h.ClientCtor).not.toHaveBeenCalled()
  })

  it('connects and lists the declared tools', async () => {
    h.execFileImpl.mockResolvedValue({ stdout: '/usr/local/bin/notebooklm-mcp\n', stderr: '' })
    h.clientConnect.mockResolvedValue(undefined)
    h.clientListTools.mockResolvedValue({ tools: [{ name: 'notebook_query' }, { name: 'cross_notebook_query' }] })

    const r = await connectNotebookLm()
    expect(r.ok).toBe(true)
    expect(r.tools).toEqual(['notebook_query', 'cross_notebook_query'])
    // the request timeout is passed explicitly, not left to the SDK's own default
    expect(h.clientListTools).toHaveBeenCalledWith(undefined, expect.objectContaining({ timeout: expect.any(Number) }))
  })

  it('classifies a not-signed-in failure distinctly, so Settings can prompt Google sign-in', async () => {
    h.execFileImpl.mockResolvedValue({ stdout: '/usr/local/bin/notebooklm-mcp\n', stderr: '' })
    h.clientConnect.mockRejectedValue(new Error('Not authenticated — run `nlm login`'))

    const r = await connectNotebookLm()
    expect(r.ok).toBe(false)
    expect(r.needsSignIn).toBe(true)
    expect(r.error).toMatch(/google account/i)
    // never a raw dump of the underlying error text
    expect(r.error).not.toMatch(/nlm login/i)
  })

  it('times out cleanly when the server never responds, via the real AbortController wiring', async () => {
    vi.useFakeTimers()
    h.execFileImpl.mockResolvedValue({ stdout: '/usr/local/bin/notebooklm-mcp\n', stderr: '' })
    h.clientConnect.mockImplementation(
      (_transport: unknown, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('This operation was aborted')))
        })
    )

    const resultPromise = connectNotebookLm()
    await vi.advanceTimersByTimeAsync(120_000)
    const r = await resultPromise
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/timed out/i)
    expect(r.needsSignIn).toBeFalsy()
  })

  it('dedupes concurrent connect calls into a single spawned client', async () => {
    h.execFileImpl.mockResolvedValue({ stdout: '/usr/local/bin/notebooklm-mcp\n', stderr: '' })
    let resolveConnect!: () => void
    h.clientConnect.mockReturnValue(new Promise<void>((r) => (resolveConnect = r)))
    h.clientListTools.mockResolvedValue({ tools: [] })

    const p1 = connectNotebookLm()
    const p2 = connectNotebookLm()
    resolveConnect()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toEqual(r2)
    expect(h.ClientCtor).toHaveBeenCalledTimes(1)
  })
})

// ─── askNotebookLm ─────────────────────────────────────────────────────────────

describe('askNotebookLm — validation (never touches the CLI/network for bad input)', () => {
  it('rejects an empty question without resolving any binary', async () => {
    const r = await askNotebookLm({ question: '   ' })
    expect(r.ok).toBe(false)
    expect(h.execFileImpl).not.toHaveBeenCalled()
  })

  it('rejects a question over the length cap without resolving any binary', async () => {
    const r = await askNotebookLm({ question: 'x'.repeat(5000) })
    expect(r.ok).toBe(false)
    expect(h.execFileImpl).not.toHaveBeenCalled()
  })
})

describe('askNotebookLm — tool selection and args', () => {
  beforeEach(() => {
    h.execFileImpl.mockResolvedValue({ stdout: '/usr/local/bin/notebooklm-mcp\n', stderr: '' })
    h.clientConnect.mockResolvedValue(undefined)
  })

  it('reports not-installed cleanly when the CLI is missing', async () => {
    h.execFileImpl.mockReset()
    h.execFileImpl.mockRejectedValue(new Error('command not found'))
    const r = await askNotebookLm({ question: 'What did we discuss?' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not installed/i)
  })

  it('scopes to notebook_query with notebook_id when notebookId is given', async () => {
    h.clientCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'The answer.' }] })
    const r = await askNotebookLm({ question: 'Summarize the sources', notebookId: 'nb-123' })
    expect(r.ok).toBe(true)
    expect(r.text).toBe('The answer.')
    const [params, resultSchema, opts] = h.clientCallTool.mock.calls[0]
    expect(params).toEqual({ name: 'notebook_query', arguments: { notebook_id: 'nb-123', query: 'Summarize the sources' } })
    expect(resultSchema).toBeUndefined()
    expect(opts).toEqual(expect.objectContaining({ timeout: expect.any(Number) }))
  })

  it('falls back to cross_notebook_query across every notebook when notebookId is omitted', async () => {
    h.clientCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'Cross-notebook answer.' }] })
    const r = await askNotebookLm({ question: 'What are the common themes?' })
    expect(r.ok).toBe(true)
    const [params] = h.clientCallTool.mock.calls[0]
    expect(params).toEqual({ name: 'cross_notebook_query', arguments: { query: 'What are the common themes?', all: true } })
  })

  it('joins multiple text content parts into one answer', async () => {
    h.clientCallTool.mockResolvedValue({
      content: [
        { type: 'text', text: 'Part one.' },
        { type: 'image', data: 'ignored' },
        { type: 'text', text: 'Part two.' }
      ]
    })
    const r = await askNotebookLm({ question: 'Anything about pricing?' })
    expect(r.ok).toBe(true)
    expect(r.text).toBe('Part one.\nPart two.')
  })

  it('surfaces a tool-level isError result as a clean failure', async () => {
    h.clientCallTool.mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'notebook not found' }] })
    const r = await askNotebookLm({ question: 'Anything about pricing?', notebookId: 'missing' })
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it('reports no-answer cleanly when the tool returns empty content', async () => {
    h.clientCallTool.mockResolvedValue({ content: [] })
    const r = await askNotebookLm({ question: 'Anything about pricing?' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/did not return an answer/i)
  })

  it('classifies a sign-in failure from the tool call itself', async () => {
    h.clientCallTool.mockRejectedValue(new Error('401 unauthorized — cookie expired'))
    const r = await askNotebookLm({ question: 'Anything about pricing?' })
    expect(r.ok).toBe(false)
    expect(r.needsSignIn).toBe(true)
  })

  it('times out at the 60s call budget via the real AbortController wiring', async () => {
    vi.useFakeTimers()
    h.clientCallTool.mockImplementation(
      (_params: unknown, _schema: unknown, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('This operation was aborted')))
        })
    )
    const resultPromise = askNotebookLm({ question: 'Anything about pricing?' })
    await vi.advanceTimersByTimeAsync(120_000)
    const r = await resultPromise
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/too long/i)
  })
})
