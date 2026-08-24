/**
 * embedded-cloudflare-key.ts — optional installer-embedded METIS_PROXY_KEY, so a fresh install can talk
 * to the operator's Cloudflare Worker (the default provider, see ipc.ts's BaseSettingsSchema.provider)
 * with zero paste-a-key setup.
 *
 * Same disclosed, opt-in pattern cahe-embedded-key.ts already uses for the Cahê pilot's Kimi key: a
 * local, gitignored bundle (build/cloudflare-embed/key.json — see .gitignore) is copied into the package
 * ONLY when the operator builds with it present (electron-builder.yml's extraResources tolerates the
 * directory being empty), and scripts/check-cloudflare-embed-key.mjs scans every packaging chain so an
 * embed is never accidental. The key is NOT hidden by this: `npx asar extract` (or, since it ships
 * outside the asar as an extraResource, a plain file read) recovers it from any installer that has it in
 * seconds — see docs/CLOUDFLARE.md. What makes this safe to ship is the key's SCOPE, not secrecy:
 *   - it is provisioned into the Worker's METIS_PROXY_KEYS array under its own "embedded-default" label
 *     (cloudflare-proxy/src/index.ts's multi-key union), never as METIS_PROXY_KEY (the operator's own key);
 *   - a labeled key is revoked independently, by removing its entry, without touching any other user's key;
 *   - the operator sizes it as a minimum-quota fallback, not a shared admin credential.
 *
 * This module only SEEDS the key into the app's own encrypted keystore (store.ts's setApiKey — the same
 * AES file keystore a pasted key goes through) once per profile, tracked by a marker file so a user's
 * later key change/removal always sticks and is never silently re-overwritten on the next launch.
 */
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getApiKey, setApiKey } from './store'
import { mainLog, auditLog } from './logger'

const PROXY_KEY_PATTERN = /^[A-Za-z0-9+/_=-]{20,}$/

interface EmbeddedCloudflareKeyBundle {
  proxyKey?: string
}

/** Per-profile marker recording the one-time embedded-key seed already ran (mirrors cahe-embedded-key.ts). */
function seededMarkerPath(): string {
  return join(app.getPath('userData'), '.cloudflare-key-seeded')
}

/**
 * Seed the bundled Cloudflare proxy key into the encrypted keystore, exactly once per profile. Best-effort
 * only — never throws, never logs the key value itself. A build with no bundle (the normal, un-embedded
 * case) is a silent no-op: normal onboarding (paste your own METIS_PROXY_KEY in Settings) is untouched.
 */
export function importEmbeddedCloudflareKey(): void {
  let marker: string
  try {
    marker = seededMarkerPath()
    if (existsSync(marker)) return // already seeded (or attempted) once for this profile — never redo
  } catch (e) {
    mainLog.warn('[embedded-cloudflare-key] could not check the seed marker; skipping', e)
    return
  }

  // Respect a key the user already has (their own paste, or an earlier seed) — never overwrite it, and
  // still burn the marker so this never fights that choice on a later launch.
  if (getApiKey('cloudflare')) {
    try {
      writeFileSync(marker, new Date().toISOString(), { mode: 0o600 })
    } catch (e) {
      mainLog.warn('[embedded-cloudflare-key] could not write the seed marker', e)
    }
    return
  }

  const bundlePath = join(process.resourcesPath, 'cloudflare-embed', 'key.json')
  if (!existsSync(bundlePath)) return // keyless build: leave the marker unwritten so a later build can still seed

  try {
    const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as EmbeddedCloudflareKeyBundle
    const key = bundle.proxyKey?.trim()
    if (!key || !PROXY_KEY_PATTERN.test(key)) {
      mainLog.warn('[embedded-cloudflare-key] embedded bundle is missing a valid proxyKey; leaving normal onboarding in place')
      return // malformed bundle: leave the marker unwritten so a corrected build can still seed
    }
    setApiKey('cloudflare', key)
    auditLog('key.set', { provider: 'cloudflare', source: 'embedded-default' })
    mainLog.info('[embedded-cloudflare-key] seeded the embedded Cloudflare proxy key')
  } catch (e) {
    // Corrupt bundle or keystore error — never block startup, and never burn the marker so a corrected
    // build gets a chance next launch.
    mainLog.warn('[embedded-cloudflare-key] embedded key import failed', e)
    return
  }

  try {
    writeFileSync(marker, new Date().toISOString(), { mode: 0o600 })
  } catch (e) {
    mainLog.warn('[embedded-cloudflare-key] could not write the seed marker', e)
  }
}
