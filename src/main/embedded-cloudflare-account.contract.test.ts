import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decryptEmbeddedBlob } from './embedded-cloudflare-crypto'
import { decryptProxyKey, encryptProxyKey } from '../../scripts/lib/embedded-cloudflare-crypto.mjs'

/**
 * MQA-273 (docs/qa/BUG-LEDGER.md) — the embedded Cloudflare account must be ON BY DEFAULT: a fresh profile
 * finishes with `provider: 'cloudflare'`, a stored key and an https endpoint (so `providerReady` is true
 * and no "Add your Cloudflare key" prompt shows) with zero user action — while nothing about that account
 * (id, endpoint or token) ever lands in tracked source.
 *
 * The credential travels ONLY inside the encrypted blob (build/cloudflare-embed/key.json, gitignored),
 * built from build-time env. Its plaintext is EITHER a bare Worker proxy key (the original shape) OR a
 * JSON {token,baseUrl} DIRECT-Cloudflare account credential. This pins that the direct shape round-trips,
 * that the runtime seeds BOTH the key and the endpoint, and that the build/gate/probe agree on the shape.
 *
 * Modules that import electron (`app`) cannot be imported in a unit test, so — following
 * cloudflare-provider.contract.test.ts's established "structural proof" pattern — the wiring is pinned as
 * anchored source text. The crypto round-trip below is real, not structural.
 */
const read = (...p: string[]): string => readFileSync(join(__dirname, ...p), 'utf8').replace(/\r\n/g, '\n')
const seedSrc = read('embedded-cloudflare-key.ts')
const embedScript = read('..', '..', 'scripts', 'embed-cloudflare-key.mjs')
const gateScript = read('..', '..', 'scripts', 'check-embedded-cloudflare-key.mjs')
const probeScript = read('..', '..', 'scripts', 'check-cloudflare-key-valid.mjs')

const DUMMY_TOKEN = 'cfut_test_dummy_0123456789ABCDEFghij+/='
const DUMMY_BASE = 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1'

describe('MQA-273 — the DIRECT Cloudflare account credential round-trips through the encrypted blob', () => {
  it('a {token,baseUrl} payload encrypts and both the build-time and runtime decryptors recover it', () => {
    const payload = JSON.stringify({ token: DUMMY_TOKEN, baseUrl: DUMMY_BASE })
    const blob = encryptProxyKey(payload)
    // Both decryptors agree (they read the same embedded-key-material.json).
    expect(decryptProxyKey(blob)).toBe(payload)
    expect(decryptEmbeddedBlob(blob)).toBe(payload)
    const obj = JSON.parse(decryptEmbeddedBlob(blob)!)
    expect(obj.token).toBe(DUMMY_TOKEN)
    expect(obj.baseUrl).toBe(DUMMY_BASE)
  })

  it('the blob is still ciphertext-only — the token never appears in it, JSON wrapper or not', () => {
    const blob = encryptProxyKey(JSON.stringify({ token: DUMMY_TOKEN, baseUrl: DUMMY_BASE }))
    const serialized = JSON.stringify(blob)
    expect(serialized.includes(DUMMY_TOKEN)).toBe(false)
    expect(serialized.includes('api.cloudflare.com')).toBe(false)
  })
})

describe('MQA-273 — the runtime seeds the endpoint alongside the key, on a fresh profile only', () => {
  it('parses a JSON {token,baseUrl} payload as a direct credential (not a bare bearer token)', () => {
    expect(seedSrc).toMatch(/JSON\.parse\(raw\)/)
    expect(seedSrc).toMatch(/baseUrl:\s*string \| null/)
  })

  it('seeds cloudflareBaseUrl through setSettings, guarded so it never clobbers an operator/user endpoint', () => {
    expect(seedSrc).toMatch(/import \{ getApiKey, setApiKey, getSettings, setSettings \} from '\.\/store'/)
    expect(seedSrc).toMatch(/getSettings\(\)\.cloudflareBaseUrl === METIS_WORKER_URL/)
    expect(seedSrc).toMatch(/setSettings\(\{ cloudflareBaseUrl: cred\.baseUrl \}\)/)
  })

  it('still respects a key the user already has, and the one-shot marker (MQA-260/261 unbroken)', () => {
    expect(seedSrc).toMatch(/if \(existsSync\(marker\)\) return/)
    expect(seedSrc).toMatch(/if \(getApiKey\('cloudflare'\)\) \{/)
  })
})

describe('MQA-273 — the build, gate and probe agree on the direct-account shape', () => {
  it('the embed script derives the account endpoint from an env account id and writes a JSON payload', () => {
    expect(embedScript).toMatch(/METIS_CLOUDFLARE_API_TOKEN/)
    expect(embedScript).toMatch(/METIS_CLOUDFLARE_ACCOUNT_ID/)
    expect(embedScript).toMatch(/client\/v4\/accounts\/\$\{accountId\}\/ai\/v1/)
    expect(embedScript).toMatch(/JSON\.stringify\(\{ token, baseUrl \}\)/)
  })

  it('the packaging gate scans for the TOKEN inside the JSON payload, not the wrapper', () => {
    expect(gateScript).toMatch(/JSON\.parse\(payload\)/)
    expect(gateScript).toMatch(/obj\.token/)
    expect(gateScript).toMatch(/scanForPlaintext\(resourcesDir, token, hits\)/)
  })

  it('the pre-ship probe validates the embedded DIRECT endpoint when the blob carries one', () => {
    expect(probeScript).toMatch(/embeddedBaseUrl/)
    expect(probeScript).toMatch(/obj\?\.baseUrl/)
  })
})
