/**
 * cloudflare-provider.contract.test.ts — structural proof that Cloudflare is wired as a first-class
 * provider AND that the "no embedded account token" design survives future edits.
 *
 * The design (product owner, not negotiable here): Métis never ships a Cloudflare account token. A
 * packaged Electron app cannot keep a secret — `npx asar extract` recovers any embedded string, which is
 * why scripts/check-cahe-package.mjs already refuses a build with a key in it. So the account token lives
 * as a Wrangler secret on a Worker the OPERATOR deploys, and each install holds only that Worker's URL
 * (settings.cloudflareBaseUrl) plus a per-user METIS_PROXY_KEY in the encrypted key store.
 *
 * index.ts is ~313 KB of Electron main wired to app/BrowserWindow singletons and cannot be imported in a
 * unit test, so — following index-audit-fixes.contract.test.ts / Settings.contract.test.ts's established
 * "structural proof" pattern (readFileSync + anchored regex over the real source) — these pin the shape of
 * each seam. Anchors are identifiers and comments, never line numbers.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { PROVIDERS } from '@shared/providers'
import {
  COOLDOWN_MS,
  isCoolingDown,
  recordAuthFailure,
  recordRateLimited,
  recordSuccess,
  resetAllProviderHealth
} from './llm/provider-health'

// Normalize CRLF to LF so every anchor is line-ending independent on a Windows checkout.
const read = (...p: string[]): string => readFileSync(join(__dirname, ...p), 'utf8').replace(/\r\n/g, '\n')

const indexSource = read('index.ts')
const ingestSource = read('brain', 'ingest.ts')
const storeSource = read('store.ts')
const openaiSource = read('llm', 'openai.ts')
const settingsSource = read('..', 'renderer', 'src', 'components', 'Settings.tsx')
const indexHtml = read('..', 'renderer', 'index.html')

describe('no Cloudflare account token can reach a build', () => {
  const shipped = [indexSource, ingestSource, storeSource, openaiSource, settingsSource]

  it('embeds no Cloudflare account id and no bearer credential in any source that ships', () => {
    for (const source of shipped) {
      // Métis talks to the operator Worker, never to the account-scoped REST endpoint directly, and a
      // Cloudflare account id is 32 lowercase hex chars. Neither belongs in a literal here.
      expect(source).not.toMatch(/api\.cloudflare\.com/)
      expect(source).not.toMatch(/CLOUDFLARE_API_TOKEN\s*[:=]\s*['"][^'"]/)
      expect(source).not.toMatch(/['"][0-9a-f]{32}['"]/)
    }
  })

  it('ships no default endpoint, so there is nowhere for a shared credential to point', () => {
    expect(PROVIDERS.cloudflare.baseUrl).toBe('')
    // The Worker URL only ever comes from settings; no literal workers.dev host in main-process code.
    expect(indexSource).not.toMatch(/workers\.dev/)
    expect(ingestSource).not.toMatch(/workers\.dev/)
    expect(storeSource).not.toMatch(/workers\.dev/)
  })

  it('routes the per-user proxy key through the encrypted key store, not settings.json', () => {
    // ENV_VAR is the getApiKey/setApiKey map — the same encrypted path every other provider key uses.
    expect(storeSource).toMatch(/cloudflare: 'METIS_PROXY_KEY'/)
    // The key must never be declared as a settings field alongside the URL.
    expect(read('..', 'shared', 'ipc.ts')).not.toMatch(/cloudflareApiKey|cloudflareToken|metisProxyKey/i)
  })
})

describe('every request seam resolves the endpoint through providerBaseUrl', () => {
  it('the live ask path no longer hand-rolls the custom/dust ternary', () => {
    expect(indexSource).toMatch(/const baseURL = providerBaseUrl\(provider, s\)/)
    expect(indexSource).not.toMatch(/provider === 'custom' \? s\.customBaseUrl/)
  })

  it('the import-recap path resolves the same way', () => {
    expect(indexSource).toMatch(/baseURL: local \? undefined : providerBaseUrl\(provider, settings\)/)
  })

  it('the brain ingest path resolves the same way', () => {
    expect(ingestSource).toMatch(/baseURL: providerBaseUrl\(provider, s\)/)
    expect(ingestSource).not.toMatch(/provider === 'custom' \? s\.customBaseUrl/)
  })

  it('the Settings key tester resolves the same way, so Test hits what the ask flow will', () => {
    expect(storeSource).toMatch(/const baseURL = providerBaseUrl\(provider, settings\)/)
    expect(storeSource).toMatch(/requiresUserBaseUrl\(provider\) && !baseURL/)
  })
})

describe('an unconfigured endpoint is a routing decision, never a silent redirect to OpenAI', () => {
  it('publicSettings marks Cloudflare unready until an https Worker URL exists', () => {
    expect(indexSource).toMatch(/s\.provider === 'cloudflare'/)
    expect(indexSource).toMatch(/test\(s\.cloudflareBaseUrl\)/)
  })

  it('pickFailover refuses a bring-your-own-endpoint provider that has none', () => {
    // Cloudflare ships a default model, so the key + model checks alone would let the failover walk hand
    // it to streamOpenAI with no baseURL — where the SDK default base URL is OpenAI's own backend.
    expect(indexSource).toMatch(/\(!requiresUserBaseUrl\(p\) \|\| !!providerBaseUrl\(p, s\)\)/)
  })

  it('the ask eligibility chain names the missing endpoint instead of failing mid-stream', () => {
    expect(indexSource).toMatch(/requiresUserBaseUrl\(provider\) && !baseURL/)
    expect(indexSource).toMatch(/No endpoint URL set for \$\{def\.label\}/)
  })

  it('the brain ingest candidate walk applies the same rule, so no transcript is misrouted', () => {
    expect(ingestSource).toMatch(/if \(requiresUserBaseUrl\(p\) && !providerBaseUrl\(p, s\)\) continue/)
  })

  it('streamOpenAI still refuses as the last line of defence', () => {
    expect(openaiSource).toMatch(/if \(requiresUserBaseUrl\(opts\.providerId\) && !opts\.baseURL\)/)
  })
})

describe('Settings offers Cloudflare the same affordances as its siblings', () => {
  it('renders a Worker endpoint field bound to cloudflareBaseUrl, with managed-config support', () => {
    expect(settingsSource).toMatch(/value=\{settings\.cloudflareBaseUrl\}/)
    expect(settingsSource).toMatch(/onCommit=\{\(v\) => patch\(\{ cloudflareBaseUrl: v \}\)\}/)
    expect(settingsSource).toMatch(/k="cloudflareBaseUrl"/)
  })

  it('auto-opens Advanced for every provider that needs a URL, not just Custom by name', () => {
    expect(settingsSource).toMatch(/useState\(requiresUserBaseUrl\(provider\)\)/)
    expect(settingsSource).toMatch(/if \(requiresUserBaseUrl\(provider\)\) setAdv\(true\)/)
  })

  it('tells the user where the token actually lives, without ever showing one', () => {
    const copy = settingsSource.slice(settingsSource.indexOf("provider === 'cloudflare' && ("))
    expect(copy).toMatch(/Wrangler secret/)
    expect(copy).toMatch(/METIS_PROXY_KEY/)
    expect(copy).toMatch(/never stores that token/)
  })
})

describe('renderer CSP is deliberately untouched', () => {
  it('does not grant blanket https: to accommodate a per-install Worker URL', () => {
    // Asks stream from the MAIN process, which no page CSP governs — Grok and Gemini already ship with no
    // connect-src entry and work. A wildcard here would weaken the renderer for every other provider to
    // serve a provider that never uses it.
    // Anchor on the real policy attribute, not the first 'connect-src' in the file — the explanatory
    // comment above it legitimately quotes the directive it is explaining.
    const policy = indexHtml.slice(indexHtml.indexOf('content="default-src'))
    const csp = policy.slice(policy.indexOf('connect-src'), policy.indexOf('script-src'))
    expect(csp).not.toMatch(/https:\s/)
    expect(csp).not.toMatch(/workers\.dev/)
    // ...and the reasoning is written down where the next person will look for it.
    expect(indexHtml).toMatch(/cloudflareBaseUrl/)
  })
})

/**
 * MQA-003/MQA-004: the circuit breaker is keyed by ProviderId and nothing in it enumerates providers, so
 * a registry addition joins automatically. Proving that with the real module beats asserting it in prose —
 * if someone ever adds a per-provider carve-out, this is what catches it.
 */
describe('Cloudflare participates in the circuit breaker like any sibling', () => {
  beforeEach(() => resetAllProviderHealth())
  afterEach(() => resetAllProviderHealth())

  it('needs two auth strikes before cooling down, exactly like a keyed cloud provider', () => {
    const now = Date.UTC(2026, 7, 20, 12, 0, 0)
    expect(recordAuthFailure('cloudflare', '401 Invalid proxy key', now)).toBe(false)
    expect(isCoolingDown('cloudflare', now)).toBe(false)
    expect(recordAuthFailure('cloudflare', '401 Invalid proxy key', now)).toBe(true)
    expect(isCoolingDown('cloudflare', now)).toBe(true)
    // ...and recovers on its own once the window elapses, so a rotated METIS_PROXY_KEY works without a restart.
    expect(isCoolingDown('cloudflare', now + COOLDOWN_MS + 1)).toBe(false)
  })

  it('cools immediately on a rate limit and clears on the next success', () => {
    const now = Date.UTC(2026, 7, 20, 12, 0, 0)
    // The operator's AI Gateway can rate-limit the whole team, so this is a live path, not a hypothetical.
    recordRateLimited('cloudflare', null, now)
    expect(isCoolingDown('cloudflare', now)).toBe(true)
    recordSuccess('cloudflare')
    expect(isCoolingDown('cloudflare', now)).toBe(false)
  })

  it('is reachable by the failover walk, which enumerates the registry rather than a hand-kept list', () => {
    expect(Object.keys(PROVIDERS)).toContain('cloudflare')
    expect(indexSource).toMatch(/const order = \(Object\.keys\(PROVIDERS\) as ProviderId\[\]\)/)
  })
})
