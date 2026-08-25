import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SEED = readFileSync(join(__dirname, 'embedded-cloudflare-key.ts'), 'utf8')
const INDEX = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const PRELOAD = readFileSync(join(__dirname, '..', 'preload', 'index.ts'), 'utf8')
const SETTINGS = readFileSync(join(__dirname, '..', 'renderer', 'src', 'components', 'Settings.tsx'), 'utf8')

/**
 * MQA-261 — the shipped key could be destroyed in one click and never come back.
 *
 * A fresh install finishes onboarding with a working Cloudflare key nobody typed. That is the whole point
 * of the embed — and it means the user has no copy of it. The Settings key card offered an unconfirmed
 * trash icon, `clearApiKey` removed the only credential they had, and the one-shot seed marker guaranteed
 * it never returned. The card then told them to paste a `METIS_PROXY_KEY` "from your operator", which for
 * a self-serve install does not exist.
 *
 * The visible result was not an error. Asks kept working, on the on-device model, at roughly 12.2s against
 * ~0.9s through the Worker (measured on packaged 1.6.2) — so the product silently became an order of
 * magnitude slower, with nothing on screen connecting that to the click.
 *
 * The fix deliberately does NOT loosen the seed marker. The marker protects the user's intent against the
 * app on every launch; the restore is the user asking, where there is no intent to protect.
 */
describe('MQA-261 — a removed shipped key has a way back', () => {
  it('exposes availability separately from "a key is stored"', () => {
    // Two different questions. The affordance needs both: a bundle EXISTS, and nothing is stored now.
    expect(SEED).toMatch(/export function embeddedCloudflareKeyAvailable\(\): boolean/)
    expect(SEED).toMatch(/export function restoreEmbeddedCloudflareKey\(\)/)
  })

  it('restore ignores the seed marker, and says why that is not a hole', () => {
    // The marker's job is to stop a LAUNCH overwriting a user's key. An explicit restore is the user, so
    // refusing would be the app overruling them. If this reasoning is ever deleted, the next reader will
    // "fix" the restore by gating it on the marker and silently remove the way back.
    const fn = SEED.slice(SEED.indexOf('export function restoreEmbeddedCloudflareKey'))
    expect(fn).not.toMatch(/seededMarkerPath\(\)/)
    expect(SEED).toMatch(/the user IS the one asking/)
  })

  it('never claims success when nothing was written', () => {
    // A restore that reports ok on a keyless build, an unreadable bundle, or a keystore failure would send
    // the user back to a card that still cannot answer, with no reason given.
    const fn = SEED.slice(SEED.indexOf('export function restoreEmbeddedCloudflareKey'))
    expect(fn).toMatch(/did not ship a Cloudflare key/)
    expect(fn).toMatch(/unreadable/)
    expect(fn).toMatch(/could not be saved to this profile/)
  })

  it('the IPC write is main-window-gated like every other credential mutation', () => {
    // The Intelligence window's reader preload must never reach a key write.
    const handler = INDEX.slice(INDEX.indexOf('ipcMain.handle(IPC.restoreEmbeddedCloudflareKey'))
    expect(handler.slice(0, 400)).toMatch(/assertMainWindow\(e\)/)
    expect(handler.slice(0, 400)).toMatch(/requireAuth\(\)/)
  })

  it('clears the recorded health verdict on restore', () => {
    // The reason a user reaches for this is usually that asks started failing. A stale auth verdict against
    // cloudflare would keep the restored key demoted until it happened to succeed.
    const handler = INDEX.slice(INDEX.indexOf('ipcMain.handle(IPC.restoreEmbeddedCloudflareKey'))
    expect(handler.slice(0, 600)).toMatch(/resetProviderHealth\('cloudflare'\)/)
  })

  it('is reachable from the renderer', () => {
    expect(PRELOAD).toMatch(/restoreEmbeddedCloudflareKey: \(\)/)
    expect(SETTINGS).toMatch(/window\.toto\.restoreEmbeddedCloudflareKey\(\)/)
  })

  it('asks before removing, instead of destroying on one click', () => {
    expect(SETTINGS).toMatch(/setConfirmRemove\(true\)/)
    expect(SETTINGS).toMatch(/confirmRemove \?/)
    // The confirm must be per-provider: one armed on a different tile must not be spendable here.
    expect(SETTINGS).toMatch(/setConfirmRemove\(false\)\s*\n\s*setRestoreMsg\(null\)\s*\n\s*\}, \[provider\]\)/)
  })

  it('offers restore only when a key is available AND not currently stored', () => {
    // Restoring over a key the user chose would be exactly the overwrite the marker exists to prevent.
    expect(SETTINGS).toMatch(
      /provider === 'cloudflare' && settings\.embeddedCloudflareKeyAvailable && !settings\.hasKeys\.cloudflare/
    )
  })

  it('tells the user the key came with the app, and what losing it costs', () => {
    // Without provenance the card's own advice ("paste your METIS_PROXY_KEY from your operator") is
    // impossible to follow on a self-serve install.
    expect(SETTINGS).toMatch(/came with Metis rather than from you/)
    expect(SETTINGS).toMatch(/private but noticeably slower/)
  })
})
