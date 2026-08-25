import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = join(__dirname, '..')
const GATE = join(REPO, 'scripts', 'check-cloudflare-key-valid.mjs')
const BUNDLE = join(REPO, 'build', 'cloudflare-embed', 'key.json')

function run(): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync(process.execPath, [GATE], { encoding: 'utf8', stdio: 'pipe', cwd: REPO }) }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
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
    // The normal, supported case. A gate demanding connectivity for every build would get turned off.
    if (existsSync(BUNDLE)) return
    const r = run()
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/no embedded key bundle/)
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
    for (const chain of ['dist:win', 'release:build:win', 'dist', 'dist:local', 'release:build:mac']) {
      const script = pkg.scripts[chain]
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

  it('REFUSES the real undeployed key — proven against the live Worker, not assumed', () => {
    // The state as of 2026-08-25: the Worker answers and rejects this key. Skipped once the bundle is
    // promoted to key.json (i.e. once it IS deployed) rather than asserting a permanent failure.
    const pending = join(REPO, 'build', 'cloudflare-embed', 'key.json.pending-deploy')
    if (!existsSync(pending) || existsSync(BUNDLE)) return
    try {
      copyFileSync(pending, BUNDLE)
      const r = run()
      expect(r.code).toBe(1)
      expect(r.out).toMatch(/REJECTED the embedded key \(HTTP 401\)/)
    } finally {
      rmSync(BUNDLE, { force: true })
    }
  }, 90_000)
})
