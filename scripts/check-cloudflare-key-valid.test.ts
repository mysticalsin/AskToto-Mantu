import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { formatCommand, releasePlans } from './release/orchestrate.mjs'

const REPO = join(__dirname, '..')
const GATE = join(REPO, 'scripts', 'check-cloudflare-key-valid.mjs')
const SENTINEL = 'CFLEAK42'
const TOKEN = `synthetic-test-token-${SENTINEL}`
const WORKER = `https://worker.invalid/${SENTINEL}/v1`
const DIRECT = `https://${SENTINEL}:synthetic-only@direct.invalid/account/fixture/v1`
const MODEL = '@cf/synthetic/probe-model'
const BLOB = { fixture: 'synthetic-build-probe-only' }

type Fixture = {
  route?: 'worker' | 'direct'
  credential?: 'keyless' | 'malformed-bundle' | 'malformed-payload' | 'decrypt-error' | 'empty'
  missing?: 'endpoint' | 'model'
  transport?: 'fetch-error' | 'abort-error'
  status?: number
}
type Evidence = {
  preloadLoaded: boolean
  decryptCalls: number
  cryptoValid: boolean
  requests: unknown[]
  requestValid: boolean
  bodyReads: number
}

// The CLI is copied unchanged; only its crypto dependency and fetch are synthetic. Evidence is persisted
// outside stdout/stderr so a fixture error caught by the CLI cannot masquerade as a successful redaction.
const RUNTIME = `
import { readFileSync, writeFileSync } from 'node:fs'
const specPath = new URL('./fixture.json', import.meta.url)
const evidencePath = new URL('./evidence.json', import.meta.url)
export const spec = JSON.parse(readFileSync(specPath, 'utf8'))
export function record(update) {
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
  update(evidence)
  writeFileSync(evidencePath, JSON.stringify(evidence))
}
`
const CRYPTO = `
import { spec, record } from '../../fixture-runtime.mjs'
export function decryptProxyKey(blob) {
  const valid = JSON.stringify(blob) === JSON.stringify(spec.blob)
  record(e => { e.decryptCalls++; e.cryptoValid = e.cryptoValid && valid })
  if (!valid) throw new Error('unexpected synthetic crypto input')
  if (spec.credential === 'decrypt-error') throw new Error(spec.failure)
  return spec.payload
}
`
const PRELOAD = `
import { spec, record } from './fixture-runtime.mjs'
record(e => { e.preloadLoaded = true })
globalThis.fetch = async (endpoint, options) => {
  let body
  try { body = JSON.parse(options?.body) } catch { body = null }
  const request = {
    endpoint, method: options?.method,
    authorization: options?.headers?.Authorization,
    contentType: options?.headers?.['Content-Type'],
    body, hasSignal: options?.signal instanceof AbortSignal
  }
  const valid = JSON.stringify(request) === JSON.stringify(spec.request)
  record(e => { e.requests.push(request); e.requestValid = e.requestValid && valid })
  if (!valid) throw new Error('unexpected synthetic fetch request')
  if (spec.transport) {
    const error = new Error(spec.failure)
    if (spec.transport === 'abort-error') error.name = 'AbortError'
    throw error
  }
  return {
    status: spec.status, ok: spec.status >= 200 && spec.status < 300,
    text: async () => { record(e => { e.bodyReads++ }); return spec.failure }
  }
}
`

function run(fixture: Fixture = {}) {
  const root = mkdtempSync(join(tmpdir(), `metis-cf-probe-${SENTINEL}-`))
  const repository = join(root, '__fixtures__')
  const write = (path: string, text: string) => {
    const target = join(root, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text)
  }
  try {
    const home = join(root, 'home')
    const temp = join(root, 'tmp')
    mkdirSync(home)
    mkdirSync(temp)
    mkdirSync(join(repository, 'scripts'), { recursive: true })
    copyFileSync(GATE, join(repository, 'scripts', 'check-cloudflare-key-valid.mjs'))
    const request = {
      endpoint: `${fixture.route === 'direct' ? DIRECT : WORKER}/chat/completions`,
      method: 'POST',
      authorization: `Bearer ${TOKEN}`,
      contentType: 'application/json',
      body: { model: MODEL, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 },
      hasSignal: true
    }
    let payload = fixture.route === 'direct' ? JSON.stringify({ token: TOKEN, baseUrl: ` ${DIRECT}/// ` }) : TOKEN
    if (fixture.credential === 'malformed-payload') payload = `{${SENTINEL}}`
    if (fixture.credential === 'empty') payload = JSON.stringify({ token: 42 })
    write(
      '__fixtures__/fixture.json',
      JSON.stringify({
        ...fixture,
        status: fixture.status ?? 200,
        payload,
        blob: BLOB,
        request,
        failure: `${SENTINEL} ${TOKEN} ${DIRECT}`
      })
    )
    write(
      '__fixtures__/evidence.json',
      JSON.stringify({
        preloadLoaded: false,
        decryptCalls: 0,
        cryptoValid: true,
        requests: [],
        requestValid: true,
        bodyReads: 0
      })
    )
    write('__fixtures__/fixture-runtime.mjs', RUNTIME)
    write('__fixtures__/scripts/lib/embedded-cloudflare-crypto.mjs', CRYPTO)
    write('__fixtures__/preload.mjs', PRELOAD)
    if (fixture.credential !== 'keyless') {
      write(
        '__fixtures__/build/cloudflare-embed/key.json',
        fixture.credential === 'malformed-bundle' ? SENTINEL : JSON.stringify(BLOB)
      )
    }
    if (fixture.missing !== 'endpoint') {
      write('__fixtures__/src/shared/ipc.ts', `export const METIS_WORKER_URL = '${WORKER}'\n`)
    }
    if (fixture.missing !== 'model') write('__fixtures__/src/shared/providers.ts', `defaultModel: '${MODEL}'\n`)
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(join(repository, 'preload.mjs')).href,
        join(repository, 'scripts', 'check-cloudflare-key-valid.mjs')
      ],
      {
        cwd: repository,
        env: {
          HOME: home,
          USERPROFILE: home,
          APPDATA: join(home, 'AppData', 'Roaming'),
          LOCALAPPDATA: join(home, 'AppData', 'Local'),
          TMPDIR: temp,
          TMP: temp,
          TEMP: temp,
          ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {})
        },
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 5_000,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024
      }
    )
    expect(result.error, 'synthetic CLI child must complete within its bound').toBeUndefined()
    expect(result.signal).toBeNull()
    const evidence = JSON.parse(readFileSync(join(repository, 'evidence.json'), 'utf8')) as Evidence
    expect(evidence.preloadLoaded).toBe(true)
    expect(evidence.cryptoValid).toBe(true)
    expect(evidence.requestValid).toBe(true)
    const decrypted = !['keyless', 'malformed-bundle'].includes(fixture.credential ?? '')
    expect(evidence.decryptCalls).toBe(decrypted ? 1 : 0)
    const fetched = fixture.credential === undefined && fixture.missing === undefined
    expect(evidence.requests).toEqual(fetched ? [request] : [])
    return { code: result.status, out: `${result.stdout}${result.stderr}`, evidence }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function expectSafeDiagnostic(result: ReturnType<typeof run>) {
  for (const sensitive of [SENTINEL, TOKEN, WORKER, DIRECT]) expect(result.out).not.toContain(sensitive)
  expect(result.out).not.toMatch(/\n\s+at |node:internal|ENOENT/)
  expect(result.evidence.bodyReads).toBe(0)
}

/**
 * MQA-254 — an embedded key the Worker rejects is worse than no embedded key.
 *
 * The whole promise of the installer-embedded key is that onboarding finishes with a working provider and
 * nothing to paste. If the key is not provisioned on the Worker, onboarding reports the provider READY —
 * `providerReady` is satisfied by a stored key plus the default endpoint, and neither knows whether the
 * key WORKS — and the first question 401s, with the user having pasted nothing to un-paste.
 *
 * Not hypothetical. On 2026-08-25 the operator ran `wrangler secret put METIS_PROXY_KEYS` and the Worker
 * still answered 401 for this key: the secret parsed fine (a malformed one returns 500, which is not what
 * came back) but did not contain it. Shipping then would have produced exactly the failure above on every
 * fresh install.
 */
describe('MQA-254 — the embedded Cloudflare key must be provably accepted before it ships', () => {
  it('skips cleanly when there is no key to embed — a keyless build needs no network', () => {
    const r = run({ credential: 'keyless' })
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/no embedded key bundle/)
    expectSafeDiagnostic(r)
  })

  it.each(['worker', 'direct'] as const)('preserves the authenticated %s request on success', (route) => {
    const r = run({ route })
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/accepted the embedded key \(HTTP 200\)/)
    expectSafeDiagnostic(r)
  })

  it.each([
    'malformed-bundle',
    'malformed-payload',
    'decrypt-error'
  ] as const)('reports %s without exception text or credential material', (credential) => {
    const r = run({ credential })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/could not be read\/decrypted/)
    expectSafeDiagnostic(r)
  })

  it('rejects a decrypted payload without a usable credential', () => {
    const r = run({ credential: 'empty' })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/no usable credential/)
    expectSafeDiagnostic(r)
  })

  it.each(['endpoint', 'model'] as const)('reports missing %s configuration without paths or stacks', (missing) => {
    const r = run({ missing })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(
      missing === 'endpoint' ? /could not read METIS_WORKER_URL/ : /could not read the Cloudflare defaultModel/
    )
    expectSafeDiagnostic(r)
  })

  it.each(['fetch-error', 'abort-error'] as const)('redacts a %s and its credential-bearing endpoint', (transport) => {
    const r = run({ route: 'direct', transport })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/could not reach the Worker/)
    expect(r.out).toMatch(/A key that cannot be verified must not ship/)
    expectSafeDiagnostic(r)
  })

  it.each([401, 403])('rejects HTTP %s without reading the response body', (status) => {
    const r = run({ status })
    expect(r.code).toBe(1)
    expect(r.out).toContain(`REJECTED the embedded key (HTTP ${status})`)
    expectSafeDiagnostic(r)
  })

  it.each([400, 429, 500])('reports HTTP %s without trusting auth acceptance or reading its body', (status) => {
    const r = run({ route: 'direct', status })
    expect(r.code).toBe(1)
    expect(r.out).toContain(`HTTP ${status}`)
    expect(r.out).not.toMatch(/accepted key/)
    expectSafeDiagnostic(r)
  })

  it('validates the SAME endpoint the app ships, read from source', () => {
    // Validating a different URL than users hit would prove nothing, so it is read, never duplicated.
    const src = readFileSync(GATE, 'utf8')
    expect(src).toMatch(/METIS_WORKER_URL/)
    expect(src).toMatch(/'src', 'shared', 'ipc\.ts'/)
  })

  it('sends a real authenticated request, not a ping a dead key would pass', () => {
    const src = readFileSync(GATE, 'utf8')
    expect(src).toMatch(/Authorization: `Bearer \$\{proxyKey\}`/)
    expect(src).toMatch(/chat\/completions/)
    expect(src).toMatch(/res\.status === 401 \|\| res\.status === 403/)
    expect(src).toMatch(/wrangler secret put METIS_PROXY_KEYS/)
  })

  it('refuses when the key cannot be VERIFIED, not only when it is rejected', () => {
    // Unreachable means unknown, and unknown must not ship: the failure it guards against is silent for
    // the user and invisible to every other gate.
    const src = readFileSync(GATE, 'utf8')
    expect(src).toMatch(/could not reach the Worker/)
    expect(src).toMatch(/A key that cannot be verified must not ship/)
  })

  it('runs before packaging, but never before the host guard', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    const chains = [
      ['dist:win', pkg.scripts['dist:win']],
      ['release:build:win', releasePlans.win.map(formatCommand).join(' && ')],
      ['dist', pkg.scripts.dist],
      ['dist:local', pkg.scripts['dist:local']],
      ['release:build:mac', releasePlans.mac.map(formatCommand).join(' && ')]
    ] as const

    for (const [chain, script] of chains) {
      expect(script, `${chain} missing`).toBeTruthy()

      const keyAt = script.indexOf('check-cloudflare-key-valid.mjs')
      const buildAt = script.indexOf('electron-builder')
      expect(keyAt, `${chain} must run the key gate`).toBeGreaterThan(-1)
      expect(buildAt, `${chain} must invoke electron-builder`).toBeGreaterThan(-1)
      // Before the packager: a post-hoc check only tells you the installer you already built is broken.
      expect(keyAt, `${chain} must validate the key BEFORE packaging`).toBeLessThan(buildAt)

      // But NOT before check-build-host. That guard answers in seconds and makes every later gate moot
      // on the wrong machine; this one makes a network round-trip. Getting that order backwards is what
      // check-build-host.test.ts caught when this gate was first wired in.
      const hostAt = script.indexOf('check-build-host.mjs')
      if (hostAt > -1) {
        expect(hostAt, `${chain}: the host guard must come first — it is the cheap one`).toBeLessThan(keyAt)
      }
    }
  })
})
