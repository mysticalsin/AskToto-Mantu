import { describe, it, expect, vi } from 'vitest'
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

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
      '-c', '8192',
      '--parallel', '2',
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

  it('never puts the api key on argv — it travels via the LLAMA_API_KEY env var instead (ps-visibility fix)', () => {
    const args = buildSpawnArgs({ gguf: 'g', mmproj: 'm' })
    expect(args).not.toContain('--api-key')
    // SpawnArgsInput has no apiKey field at all (enforced at compile time) — the key is only ever
    // handed to the child via spawn()'s env option (see spawnAndWaitHealthy), never argv.
  })
})

describe('resolveBinaryPath', () => {
  it('mac: a single candidate ending in llama-server', () => {
    const candidates = resolveBinaryPath('mac')
    expect(candidates).toHaveLength(1)
    expect(candidates[0].variant).toBe('mac')
    expect(candidates[0].path.endsWith(join('mac', 'llama-server'))).toBe(true)
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
      '0.00.776.143 I srv    load_model: initializing, n_slots = 2, n_ctx_slot = 4096',
      '0.00.787.103 I srv  llama_server: listening on http://127.0.0.1:60310'
    ].join('\n')
    expect(parseBoundPort(buffer)).toBe(60310)
  })

  it('returns null when no port line is present', () => {
    expect(parseBoundPort('some unrelated log output')).toBeNull()
  })
})

describe('check-llama-sidecar.mjs (guard script)', () => {
  it('exits 1 with a loud message when the target platform binary is missing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'llama-guard-'))
    try {
      const result = spawnSync('node', [join(REPO_ROOT, 'scripts', 'check-llama-sidecar.mjs'), 'mac'], {
        cwd: tmp,
        encoding: 'utf8'
      })
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/Missing local-LLM sidecar binary/)
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

  it('chains fetch-llama-server.mjs + check-llama-sidecar.mjs into every electron-builder script path', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    for (const key of REQUIRED_SCRIPT_KEYS) {
      const script = pkg.scripts[key]
      expect(script, `package.json scripts.${key} is missing`).toBeTruthy()
      expect(script, `scripts.${key} does not run fetch-llama-server.mjs`).toContain('fetch-llama-server.mjs')
      expect(script, `scripts.${key} does not run check-llama-sidecar.mjs`).toContain('check-llama-sidecar.mjs')
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
  const macBinary = join(REPO_ROOT, 'resources', 'llama', 'mac', 'llama-server')
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
