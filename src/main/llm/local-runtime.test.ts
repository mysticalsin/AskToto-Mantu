import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { EventEmitter } from 'node:events'

// local-runtime.ts imports auditLog from ../logger, which imports `app` from electron — mock both so the
// module loads under plain Node (mirrors dust.test.ts's mocking style for the same import chain).
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp' } }))
vi.mock('../logger', () => ({ mainLog: { info: vi.fn(), warn: vi.fn() }, auditLog: vi.fn() }))

import {
  buildSpawnArgs,
  parseBoundPort,
  resolveBinaryPath,
  start,
  stop,
  isRunning,
  sessionKey,
  baseURL
} from './local-runtime'

const REPO_ROOT = process.cwd()

describe('buildSpawnArgs', () => {
  // The spawn contract (PLAN.md §4.4) is IDENTICAL on mac and win — parameterize over both platforms to
  // prove that invariant explicitly rather than assuming it.
  it.each(['mac', 'win'] as const)('produces the exact sidecar flag set on %s', () => {
    const args = buildSpawnArgs({ gguf: '/models/model.gguf', mmproj: '/models/mmproj.gguf' })
    expect(args).toEqual([
      '-m', '/models/model.gguf',
      '--mmproj', '/models/mmproj.gguf',
      '--host', '127.0.0.1',
      '--port', '0',
      '-c', '65536',
      '--parallel', '2',
      '--cache-ram', '128',
      '-ngl', '99',
      '--no-ui',
      '--jinja',
      '--reasoning', 'off'
    ])
  })

  it('never includes --cache-reuse (disabled upstream for multimodal loads — PLAN.md §3)', () => {
    const args = buildSpawnArgs({ gguf: 'g', mmproj: 'm' })
    expect(args).not.toContain('--cache-reuse')
  })

  it('gives each of the two slots 32768 tokens and caps host prompt-cache RAM at 128 MiB', () => {
    const args = buildSpawnArgs({ gguf: 'g', mmproj: 'm' })
    const totalContext = Number(args[args.indexOf('-c') + 1])
    const slots = Number(args[args.indexOf('--parallel') + 1])
    expect(totalContext / slots).toBe(32768)
    expect(args.slice(args.indexOf('--cache-ram'), args.indexOf('--cache-ram') + 2)).toEqual([
      '--cache-ram',
      '128'
    ])
  })

  it('never puts the api key on argv — it travels via the LLAMA_API_KEY env var instead (ps-visibility fix)', () => {
    const args = buildSpawnArgs({ gguf: 'g', mmproj: 'm' })
    expect(args).not.toContain('--api-key')
    // SpawnArgsInput has no apiKey field at all (enforced at compile time) — the key is only ever
    // handed to the child via spawn()'s env option (see spawnAndWaitHealthy), never argv.
  })
})

describe('resolveBinaryPath', () => {
  it('mac: a single candidate under the running arch, not the other one', () => {
    const candidates = resolveBinaryPath('mac')
    expect(candidates).toHaveLength(1)
    expect(candidates[0].variant).toBe('mac')
    // The universal package ships both arches; the runtime must pick the slice it is executing as.
    // Asserting only the suffix would pass on a build that hardcoded a single arch, which is the
    // regression that leaves Métis Local dead on half the install base.
    expect(candidates[0].path.endsWith(join('mac', process.arch, 'llama-server'))).toBe(true)
    const otherArch = process.arch === 'arm64' ? 'x64' : 'arm64'
    expect(candidates[0].path).not.toContain(join('mac', otherArch))
  })

  it('win: Vulkan first, CPU fallback second, both ending in llama-server.exe', () => {
    const candidates = resolveBinaryPath('win')
    expect(candidates).toHaveLength(2)
    expect(candidates[0].variant).toBe('vulkan')
    expect(candidates[0].path.endsWith(join('win', 'vulkan', 'llama-server.exe'))).toBe(true)
    expect(candidates[1].variant).toBe('cpu')
    expect(candidates[1].path.endsWith(join('win', 'cpu', 'llama-server.exe'))).toBe(true)
  })
})

describe('parseBoundPort', () => {
  it('extracts the port from the exact llama-server startup log line (live spike text, PLAN.md §4.4)', () => {
    const line = '0.00.787.103 I srv  llama_server: listening on http://127.0.0.1:60657'
    expect(parseBoundPort(line)).toBe(60657)
  })

  it('finds the line inside a larger multi-line buffer (real stdout carries model-load logging first)', () => {
    const buffer = [
      '0.00.050.937 I srv    load_model: loading model \'Qwen3.5-0.8B-UD-Q4_K_XL.gguf\'',
      '0.00.776.143 I srv    load_model: initializing, n_slots = 2, n_ctx_slot = 32768',
      '0.00.787.103 I srv  llama_server: listening on http://127.0.0.1:60310'
    ].join('\n')
    expect(parseBoundPort(buffer)).toBe(60310)
  })

  it('returns null when no port line is present', () => {
    expect(parseBoundPort('some unrelated log output')).toBeNull()
  })
})

describe('check-llama-sidecar.mjs (guard script)', () => {
  it('exits 1 naming BOTH mac arches when the sidecars are missing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'llama-guard-'))
    try {
      const result = spawnSync('node', [join(REPO_ROOT, 'scripts', 'check-llama-sidecar.mjs'), 'mac'], {
        cwd: tmp,
        encoding: 'utf8'
      })
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/Missing local-LLM sidecar binaries/)
      // The mac package is universal, so the guard has to fail on EITHER arch being absent — a build
      // that provisioned only the host arch would otherwise sail through and ship Métis Local dead on
      // every Mac of the other kind. Naming both proves the guard covers the pair, not just one.
      expect(result.stderr).toContain(join('resources', 'llama', 'mac', 'arm64', 'llama-server'))
      expect(result.stderr).toContain(join('resources', 'llama', 'mac', 'x64', 'llama-server'))
      expect(result.stderr).toMatch(/fetch-llama-server\.mjs mac/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('exits 1 for a Windows target missing the vulkan OR cpu binary', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'llama-guard-win-'))
    try {
      const result = spawnSync('node', [join(REPO_ROOT, 'scripts', 'check-llama-sidecar.mjs'), 'win'], {
        cwd: tmp,
        encoding: 'utf8'
      })
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/Missing local-LLM sidecar binaries/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('packaging wiring (mechanical — missing wiring fails this suite)', () => {
  const REQUIRED_SCRIPT_KEYS = [
    'predist',
    'predist:win',
    'dist:local',
    'dist:win:appx',
    'release',
    'release:win',
    'release:mas',
    'release:win:store'
  ] as const

  function expandScript(key: string, scripts: Record<string, string>, seen = new Set<string>()): string {
    if (seen.has(key)) throw new Error(`Cyclic npm script alias: ${[...seen, key].join(' -> ')}`)
    const script = scripts[key]
    if (!script) return ''
    const alias = /^npm run ([\w:-]+)$/.exec(script)?.[1]
    if (!alias) return script
    return `${script} && ${expandScript(alias, scripts, new Set([...seen, key]))}`
  }

  it('chains fetch-llama-server.mjs + check-llama-sidecar.mjs into every electron-builder script path', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    for (const key of REQUIRED_SCRIPT_KEYS) {
      expect(pkg.scripts[key], `package.json scripts.${key} is missing`).toBeTruthy()
      const expanded = expandScript(key, pkg.scripts)
      expect(expanded, `scripts.${key} does not run fetch-llama-server.mjs`).toContain('fetch-llama-server.mjs')
      expect(expanded, `scripts.${key} does not run check-llama-sidecar.mjs`).toContain('check-llama-sidecar.mjs')
    }
  })

  it('build.yml caches resources/llama (keyed on fetch-llama-server.mjs) and runs the guard on BOTH platform jobs', () => {
    const yml = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'build.yml'), 'utf8')
    const macStart = yml.indexOf('build-macos:')
    const winStart = yml.indexOf('build-windows:')
    expect(macStart, 'build-macos job not found').toBeGreaterThan(-1)
    expect(winStart, 'build-windows job not found').toBeGreaterThan(-1)
    const macJob = yml.slice(macStart, winStart)
    const winJob = yml.slice(winStart)

    for (const [name, job] of [
      ['macOS', macJob],
      ['Windows', winJob]
    ] as const) {
      expect(job, `${name} job doesn't cache resources/llama`).toMatch(/resources\/llama/)
      expect(job, `${name} job's cache key doesn't include fetch-llama-server.mjs`).toMatch(
        /hashFiles\('scripts\/fetch-llama-server\.mjs'\)/
      )
    }
    // The guard runs via predist/predist:win (npm pre-hooks, asserted above) plus dist:win:appx's own
    // inline chain — confirm both jobs actually invoke the npm scripts that carry it.
    expect(macJob, 'macOS job does not run npm run dist').toContain('npm run dist')
    expect(winJob, 'Windows job does not run npm run dist:win').toContain('npm run dist:win')
    expect(winJob, 'Windows job does not run npm run dist:win:appx').toContain('npm run dist:win:appx')
  })
})

describe('will-quit wiring (index.ts) — F3', () => {
  it('kills the local sidecar synchronously on app quit', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'main', 'index.ts'), 'utf8')
    const startIdx = src.indexOf("app.on('will-quit'")
    expect(startIdx, 'will-quit handler not found in index.ts').toBeGreaterThan(-1)
    // The handler body is short (globalShortcut.unregisterAll + the notif timer clear + the sidecar kill)
    // — a bounded window after the handler's opening line is enough, mirroring the build.yml job-slicing
    // pattern above rather than trying to balance-parse braces.
    const endIdx = src.indexOf('\n})', startIdx)
    const body = src.slice(startIdx, endIdx > -1 ? endIdx : startIdx + 400)
    expect(body).toMatch(/localRuntime\.stop\(\)/)
  })
})

describe('start() integration — real binary + real Qwen3.5-0.8B model', () => {
  // This test SPAWNS the binary, so it needs the slice this process can actually execute — the
  // universal package's other arch is present on disk but would fail with an exec-format error.
  const macBinary = join(REPO_ROOT, 'resources', 'llama', 'mac', process.arch, 'llama-server')
  const gguf = '/Users/tony/AI-Brain-build/llama-spike/Qwen3.5-0.8B-UD-Q4_K_XL.gguf'
  const mmproj = '/Users/tony/AI-Brain-build/llama-spike/mmproj-F16.gguf'

  const missing: string[] = []
  if (!existsSync(macBinary)) missing.push(`mac binary (${macBinary})`)
  if (!existsSync(gguf)) missing.push(`gguf model (${gguf})`)
  if (!existsSync(mmproj)) missing.push(`mmproj (${mmproj})`)
  const ready = missing.length === 0
  const title = ready
    ? 'spawns the real sidecar, parses the ephemeral port, reaches health 200, then stops cleanly'
    : `skipped — missing: ${missing.join('; ')}`
  const run = ready ? it : it.skip

  run(
    title,
    async () => {
      await start({ gguf, mmproj }, 'mac')
      try {
        expect(isRunning()).toBe(true)
        expect(sessionKey()).toMatch(/^[0-9a-f]{64}$/)
        const base = new URL(baseURL())
        const health = await fetch(`${base.protocol}//${base.host}/health`)
        expect(health.status).toBe(200)
        // Proves the api key actually reached the child via the LLAMA_API_KEY env var (FIX 2): a
        // request without the key is rejected by /v1/chat/completions (llama-server leaves /v1/models
        // and /health unauthenticated regardless of --api-key, so those two can't prove this), and the
        // SAME key sessionKey() hands to real requests is accepted — round-tripping through the real
        // spawned process, not a mock. max_tokens: 1 mirrors prewarm()'s minimal-cost request shape.
        const body = JSON.stringify({ model: 'local', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 })
        const headers = { 'content-type': 'application/json' }
        const unauthed = await fetch(`${base.protocol}//${base.host}/v1/chat/completions`, {
          method: 'POST',
          headers,
          body
        })
        expect(unauthed.status).toBe(401)
        const authed = await fetch(`${base.protocol}//${base.host}/v1/chat/completions`, {
          method: 'POST',
          headers: { ...headers, authorization: `Bearer ${sessionKey()}` },
          body
        })
        expect(authed.status).toBe(200)
      } finally {
        stop()
      }
      expect(isRunning()).toBe(false)
    },
    60_000
  )
})

// ─── Startup hardening (faked child process) ──────────────────────────────────────────────────────────
// The two blocks below need a faked `node:child_process` + `fetch` so the "spawn -> listening line ->
// health" timing is controllable. The real-binary integration block above must keep the REAL spawn, and
// vi.mock() is file-scoped + hoisted — so load a private, freshly-registered copy of local-runtime via
// vi.resetModules() + vi.doMock() instead (the same fake-proc shape local-runtime.concurrency.test.ts
// uses). Each load also yields pristine module-level state — the sticky CPU pin and the restart budget
// both live for the life of the module, and these tests depend on starting from zero.

interface FakeProc {
  stdout: EventEmitter
  stderr: EventEmitter
  killed: boolean
  kill: ReturnType<typeof vi.fn>
  emit: (event: string, ...args: unknown[]) => boolean
}

interface Harness {
  runtime: typeof import('./local-runtime')
  logger: typeof import('../logger')
  procs: FakeProc[]
  calls: Array<{ path: string; args: string[] }>
}

async function loadIsolatedRuntime(): Promise<Harness> {
  vi.resetModules()
  const procs: FakeProc[] = []
  const calls: Array<{ path: string; args: string[] }> = []
  vi.doMock('node:child_process', async () => {
    const { EventEmitter: EE } = await import('node:events')
    const spawn = vi.fn((path: string, args: string[]) => {
      const proc = new EE() as unknown as FakeProc
      proc.stdout = new EE()
      proc.stderr = new EE()
      proc.killed = false
      proc.kill = vi.fn(() => {
        if (proc.killed) return
        proc.killed = true
        queueMicrotask(() => proc.emit('exit', null, 'SIGKILL'))
      })
      procs.push(proc)
      calls.push({ path, args })
      return proc
    })
    return { spawn }
  })
  // Every candidate binary must "exist" so the loop never short-circuits on the missing-binary path —
  // only spawn/health timing matters here. The integration block above resolved node:fs at file load,
  // so its real existsSync is unaffected.
  vi.doMock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>()
    return { ...actual, existsSync: () => true }
  })
  // Imported from the freshly-reset registry so both objects are the ones the isolated runtime actually
  // holds — the module-level vi.mock factories re-run on reset and hand out new vi.fn()s.
  const runtime = await import('./local-runtime')
  const logger = await import('../logger')
  return { runtime, logger, procs, calls }
}

function emitListening(h: Harness, procIndex: number, port: number): void {
  h.procs[procIndex].stdout.emit(
    'data',
    Buffer.from(`0.00.787.103 I srv llama_server: listening on http://127.0.0.1:${port}\n`)
  )
}

async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out')
    await new Promise((r) => setTimeout(r, 1))
  }
}

describe('port-line timeout — a sidecar that starts but never reports a listening port', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('rejects once the port-line budget expires instead of waiting forever, and kills the child', async () => {
    const h = await loadIsolatedRuntime()
    vi.stubGlobal('fetch', async () => ({ status: 200 }))
    // Only the timers are faked: pollHealth's Date.now() and the fake proc's queueMicrotask must stay real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    let outcome: 'resolved' | 'rejected' | undefined
    let err: unknown
    void h.runtime.start({ gguf: '/m/a.gguf', mmproj: '/m/a.mmproj' }, 'mac').then(
      () => {
        outcome = 'resolved'
      },
      (e) => {
        outcome = 'rejected'
        err = e
      }
    )

    // The child spawned fine — it just never prints "listening on http://127.0.0.1:<port>" (wrong build,
    // GPU driver stall, a llama.cpp log-format change). Nothing else settles this promise: the
    // HEALTH_BUDGET_MS deadline only starts counting once that line has been parsed.
    expect(h.calls).toHaveLength(1)
    h.procs[0].stdout.emit('data', Buffer.from('0.00.050.937 I srv load_model: loading model\n'))

    // A slow-but-healthy cold start (Defender scan + GGUF read off a cold disk) must NOT be cut off: the
    // budget is deliberately generous, so nothing may settle before it elapses.
    await vi.advanceTimersByTimeAsync(59_000)
    expect(outcome).toBeUndefined()

    await vi.advanceTimersByTimeAsync(2_000)
    for (let i = 0; i < 5; i++) await Promise.resolve()

    // FAILS before the fix: with no port-line timeout `outcome` is still undefined here — start() stays
    // pending forever and Métis Local is permanently wedged with no error surfaced to the user.
    expect(outcome).toBe('rejected')
    expect(String(err)).toMatch(/never reported a listening port within 60000ms/)
    expect(String(err)).toMatch(/load_model: loading model/) // the tail is carried for diagnosis
    // Killed AND reaped — no orphan llama-server survives the timeout holding the model's RAM.
    expect(h.procs[0].kill).toHaveBeenCalledWith('SIGKILL')
    expect(h.procs[0].killed).toBe(true)
    expect(h.calls).toHaveLength(1)
    expect(h.runtime.getState()).toBe('stopped')
    expect(h.runtime.isRunning()).toBe(false)
  })
})

describe('sticky CPU fallback — a Vulkan sidecar that crashes AFTER reaching running', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('pins the CPU build for the rest of the session instead of auto-restarting Vulkan into a crash loop', async () => {
    const h = await loadIsolatedRuntime()
    vi.stubGlobal('fetch', async () => ({ status: 200 }))
    const paths = { gguf: '/m/a.gguf', mmproj: '/m/a.mmproj' }

    const p = h.runtime.start(paths, 'win')
    expect(h.calls[0].path).toContain(join('win', 'vulkan', 'llama-server.exe'))
    emitListening(h, 0, 55901)
    await p
    expect(h.runtime.isRunning()).toBe(true)

    // Vulkan initialized fine, served for a while, then died mid-inference — the older-Intel-iGPU failure
    // mode. 0xC0000005 (access violation) is what those drivers actually surface as the child's exit code.
    h.procs[0].emit('exit', 3221225477, null)
    await waitUntil(() => h.calls.length === 2)

    // FAILS before the fix: maybeAutoRestart() re-spawned resolveBinaryPath()'s FIRST candidate, so
    // calls[1] was the same Vulkan build — which crashes again, exhausts the restart budget, and strands
    // the session 'unavailable' without ever trying the bundled CPU build.
    expect(h.calls[1].path).toContain(join('win', 'cpu', 'llama-server.exe'))
    emitListening(h, 1, 55902)
    await waitUntil(() => h.runtime.isRunning())
    expect(h.runtime.baseURL()).toBe('http://127.0.0.1:55902/v1')
    expect(h.logger.mainLog.warn).toHaveBeenCalledWith(
      expect.stringMatching(/pinning CPU sidecar/),
      expect.objectContaining({ code: 3221225477 })
    )
    h.runtime.stop()
  })

  it('leaves the Vulkan-first order intact when no Vulkan crash has happened this session', async () => {
    const h = await loadIsolatedRuntime()
    vi.stubGlobal('fetch', async () => ({ status: 200 }))
    const paths = { gguf: '/m/a.gguf', mmproj: '/m/a.mmproj' }

    const p = h.runtime.start(paths, 'win')
    emitListening(h, 0, 56001)
    await p
    // A model SWITCH is not a crash — the GPU build must still be preferred.
    const p2 = h.runtime.start({ gguf: '/m/b.gguf', mmproj: '/m/b.mmproj' }, 'win')
    await waitUntil(() => h.calls.length === 2)
    expect(h.calls[1].path).toContain(join('win', 'vulkan', 'llama-server.exe'))
    emitListening(h, 1, 56002)
    await p2
    h.runtime.stop()
  })
})
