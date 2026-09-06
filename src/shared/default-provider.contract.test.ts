/**
 * default-provider.contract.test.ts — MQA-219.
 *
 * Which provider a fresh install talks to is a load-bearing product decision, and until this file it was
 * pinned by nothing: the default moved from NVIDIA NIM to Cloudflare and the entire 2962-test suite
 * stayed green. A default can break in three quiet ways, and each one ships fine without a gate:
 *
 *   1. The two declarations drift. `BaseSettingsSchema`'s `ProviderIdSchema.default(...)` is what an
 *      unparseable or partial settings.json heals to; `DEFAULT_SETTINGS` is what a brand-new profile is
 *      written with. If they disagree, a first run and a recovered run use different providers, and only
 *      one of them is the one anybody tested.
 *   2. The default is not offered. Settings splits tiles by `tier`, and 'more' is a COLLAPSED drawer. A
 *      default sitting in that drawer is a provider the user is on but cannot see.
 *   3. The default ships a placeholder endpoint. Cloudflare answers at a URL the operator supplies, and
 *      the docs and the Settings placeholder both carry `your-subdomain` examples. Shipping one of those
 *      as the real default would point every install at a host that does not exist.
 */
import { describe, it, expect } from 'vitest'
import { BaseSettingsSchema, DEFAULT_SETTINGS } from './ipc'
import { PROVIDERS, requiresUserBaseUrl } from './providers'

/** What a partial/corrupt settings.json heals this one field to. Read the field rather than parsing an
 *  empty object: several sibling fields are deliberately required, so a whole-object parse would throw. */
const schemaDefault = BaseSettingsSchema.shape.provider.parse(undefined)

describe('MQA-219 — the default provider is one decision, in one state, and is actually reachable', () => {
  it('the schema default and DEFAULT_SETTINGS agree, so a healed profile and a fresh one match', () => {
    expect(schemaDefault).toBe(DEFAULT_SETTINGS.provider)
  })

  it('the default is a real registry entry', () => {
    expect(PROVIDERS[DEFAULT_SETTINGS.provider]).toBeDefined()
  })

  it('the default is offered where the user can see it, never inside the collapsed drawer', () => {
    // 'more' is rendered behind "Experience: more models", shut by default. A default the user is
    // already on, hidden there, is a provider they cannot configure without first going hunting.
    expect(PROVIDERS[DEFAULT_SETTINGS.provider].tier).not.toBe('more')
  })

  it('a default whose endpoint the operator supplies ships a real URL or none, never a placeholder', () => {
    if (!requiresUserBaseUrl(DEFAULT_SETTINGS.provider)) return
    const url = DEFAULT_SETTINGS.cloudflareBaseUrl
    if (url === '') return // not preset yet: the user pastes it, which is a supported state
    expect(url, 'a preset endpoint must be https').toMatch(/^https:\/\//i)
    // The exact strings that live in docs/CLOUDFLARE.md and the Settings placeholder. Shipping one of
    // them as the default would give every install a hostname that resolves to nothing.
    expect(url).not.toMatch(/your-subdomain|<[A-Za-z_]+>|example\.(com|workers\.dev)/i)
    // The OpenAI client appends /chat/completions, so the base has to carry the /v1 suffix.
    expect(url.replace(/\/+$/, '')).toMatch(/\/v1$/)
  })

  it('Cloudflare is the always-on default; Local AI routing is opt-in (weights still download on open)', () => {
    // Cloudflare ships with a Worker URL (+ optional embedded key). Local routing stays off until the
    // user turns it on; the weight download is independent and starts whenever the app opens.
    expect(DEFAULT_SETTINGS.provider).toBe('cloudflare')
    expect(DEFAULT_SETTINGS.cloudflareBaseUrl).toMatch(/^https:\/\//)
    expect(DEFAULT_SETTINGS.localLlm.enabled).toBe(false)
    expect(DEFAULT_SETTINGS.localLlm.fallback).toBe(false)
  })

  it('the on-device model still only PREEMPTS when the user asks it to', () => {
    // Tony's routing order: a toggled-on local model wins, otherwise the default provider does. These
    // must stay false or local silently becomes primary for everyone.
    expect(DEFAULT_SETTINGS.localLlm.useFor).toEqual({ suggest: false, summary: false, vision: false })
  })
})

describe('Apple-grade defaults (METIS-PLATFORM-NORTH-STAR §3.4)', () => {
  it('fresh install recedes and fails closed', () => {
    expect(DEFAULT_SETTINGS.overlayLayout).toBe('hide')
    expect(DEFAULT_SETTINGS.overlayOrbStyle).toBe('bar')
    expect(DEFAULT_SETTINGS.providerPriority).toBe('api')
    expect(DEFAULT_SETTINGS.encryptTranscripts).toBe(true)
    expect(DEFAULT_SETTINGS.operatorUrl).toBe('')
    expect(DEFAULT_SETTINGS.localLlm.enabled).toBe(false)
  })

  it('schema heals garbage overlay and orb keys to the friendly defaults', () => {
    expect(BaseSettingsSchema.shape.overlayLayout.parse(undefined)).toBe('hide')
    expect(BaseSettingsSchema.shape.overlayOrbStyle.parse(undefined)).toBe('bar')
    expect(BaseSettingsSchema.shape.providerPriority.parse(undefined)).toBe('api')
    expect(BaseSettingsSchema.shape.encryptTranscripts.parse(undefined)).toBe(true)
  })
})
