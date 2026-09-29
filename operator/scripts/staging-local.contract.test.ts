import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHermeticSandbox, hermeticWranglerEnv, mergedEnv } from '../../scripts/hermetic/sandbox-env.mjs'

// M2-0103 — the staging contract lane that needs no Cloudflare account. `migrate.mjs --local` builds the
// schema in a throwaway local D1, then `wrangler dev --local --env staging` serves the staging
// configuration from miniflare. Credentials are stripped by hermeticWranglerEnv and every connect() from
// the wrangler Node process goes through the loopback-only preload, so nothing here can reach a real
// account. The live staging chain stays BLOCKED_EXTERNAL until the account owner supplies the D1 id (see
// the staging runbook); this lane is what proves the code and routes against it meanwhile.
const REPO_ROOT = resolve(__dirname, '..', '..')
const OPERATOR_DIR = resolve(REPO_ROOT, 'operator')
const WRANGLER_BIN = resolve(REPO_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const MIGRATE = resolve(OPERATOR_DIR, 'scripts', 'migrate.mjs')
const DENY_NON_LOOPBACK = resolve(REPO_ROOT, 'scripts', 'hermetic', 'deny-non-loopback.cjs')
// A throwaway value that only exists for this local Worker; it is not a credential for anything.
const LOCAL_INGEST_SECRET = 'local-contract-lane-secret'

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolvePort(port))
    })
  })
}

async function waitForHealth(base: string, dev: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (dev.exitCode !== null) throw new Error(`wrangler dev exited early (${dev.exitCode}):\n${output()}`)
    try {
      const res = await fetch(`${base}/health`)
      if (res.status === 200) return
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`wrangler dev never became healthy:\n${output()}`)
}

describe.skipIf(process.platform === 'win32')('local staging contract lane (no Cloudflare credentials)', () => {
  let sandbox: ReturnType<typeof createHermeticSandbox>
  let dev: ChildProcess | undefined
  let base = ''
  let devOutput = ''

  beforeAll(async () => {
    sandbox = createHermeticSandbox()
    const env = mergedEnv(hermeticWranglerEnv(sandbox))
    env.NODE_OPTIONS = `--require "${DENY_NON_LOOPBACK}"`
    env.CI = 'true'
    const state = resolve(sandbox.tmp, 'wrangler-state')

    const migrate = spawnSync(process.execPath, [MIGRATE, '--local', '--env', 'staging', '--persist-to', state], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env
    })
    expect(migrate.stderr, migrate.stdout).not.toContain('HERMETIC_NETWORK_DENIED')
    expect(migrate.status, `${migrate.stdout}\n${migrate.stderr}`).toBe(0)

    const port = await freePort()
    base = `http://127.0.0.1:${port}`
    dev = spawn(
      process.execPath,
      [
        WRANGLER_BIN,
        'dev',
        '--local',
        '--env',
        'staging',
        '--ip',
        '127.0.0.1',
        '--port',
        String(port),
        '--inspector-port',
        '0',
        '--persist-to',
        state,
        '--var',
        `OPERATOR_INGEST_SECRET:${LOCAL_INGEST_SECRET}`
      ],
      { cwd: OPERATOR_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    dev.stdout?.on('data', (chunk) => (devOutput += chunk))
    dev.stderr?.on('data', (chunk) => (devOutput += chunk))
    await waitForHealth(base, dev, () => devOutput)
  }, 150_000)

  afterAll(() => {
    dev?.kill('SIGTERM')
    if (sandbox) rmSync(sandbox.home, { recursive: true, force: true })
  })

  it('/health reports the staging environment with an applied schema', async () => {
    const body = (await (await fetch(`${base}/health`)).json()) as {
      ok: boolean
      env: string
      d1: string
      schema: string | string[]
    }
    expect(body.ok).toBe(true)
    expect(body.env).toBe('staging')
    expect(body.d1).toBe('ok')
    expect(body.schema).toBe('ok')
  })

  it.each([
    ['POST', '/v1/ingest'],
    ['POST', '/v1/heartbeat'],
    ['POST', '/v1/use'],
    ['POST', '/v1/ask'],
    ['GET', '/v1/integrations']
  ])('%s %s answers 401 JSON without device credentials', async (method, path) => {
    const res = await fetch(`${base}${path}`, { method, ...(method === 'POST' ? { body: '{}' } : {}) })
    expect(res.status).toBe(401)
    expect(res.headers.get('content-type')).toMatch(/json/)
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false)
  })

  it('never wrote a network denial while serving', () => {
    expect(devOutput).not.toContain('HERMETIC_NETWORK_DENIED')
  })
})
