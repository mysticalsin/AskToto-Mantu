/**
 * embedded-cloudflare-key.ts — the optional installer-embedded Cloudflare credential, so a fresh install
 * can reach Cloudflare (the default provider, see ipc.ts's BaseSettingsSchema.provider) with zero
 * paste-a-key setup.
 *
 * TWO SHAPES, ONE BLOB. The build step (scripts/embed-cloudflare-key.mjs) AES-256-GCM-encrypts a plaintext
 * payload under a key derived (scrypt) from build-stable material (appId + an obfuscation secret in
 * embedded-key-material.json) and writes only the ciphertext blob to build/cloudflare-embed/key.json,
 * which electron-builder copies to resources/cloudflare-embed/key.json. The decrypted payload is EITHER:
 *   - a bare string  → a Worker METIS_PROXY_KEY (the original design: token stays on an operator Worker,
 *     the app just points settings.cloudflareBaseUrl at that Worker's URL — docs/CLOUDFLARE.md); or
 *   - a JSON object {"token","baseUrl"} → a DIRECT Cloudflare account credential: `token` is the account
 *     API token sent as `Authorization: Bearer …`, `baseUrl` is the account-scoped OpenAI-compatible REST
 *     endpoint (https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1). Métis then talks to Cloudflare
 *     directly, no Worker in the path. Product owner's on-by-default configuration (they rotate the token
 *     out-of-band). NOTHING about that account — id, endpoint or token — lives in tracked source; the whole
 *     credential travels only inside this encrypted blob, provided at build time.
 *
 * At runtime this module reads that blob and decrypts it IN MEMORY (decryptEmbeddedBlob, static-import +
 * bytecode-safe — docs/DEVELOPMENT.md). The decrypted plaintext is never written to disk or logs; what
 * lands on disk is only ever the app's OWN encrypted keystore blob (store.ts's setApiKey, the exact same
 * at-rest encryption a user-pasted key gets) plus, for the direct shape, the (non-secret) endpoint URL in
 * settings.
 *
 * SECURITY HONESTY (do not soften this): encrypting a credential with material that ALSO ships in the app
 * is OBFUSCATION, not secrecy. A determined attacker with the binary can re-derive the key and decrypt the
 * blob — this only raises the bar above a plaintext file that `npx asar extract` reads in seconds. The
 * truly-secure option, where the token never ships at all, is the Worker proxy (docs/CLOUDFLARE.md). What
 * makes an embedded credential safe to ship is its SCOPE — a revocable, rate-limited account token the
 * operator rotates — never this encryption.
 *
 * This module only SEEDS the decrypted credential (key into the encrypted keystore, and for the direct
 * shape the endpoint into settings) once per profile, tracked by a marker file so a user's later key
 * change/removal always sticks and is never silently re-overwritten on the next launch.
 */
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getApiKey, setApiKey, getSettings, setSettings } from './store'
import { METIS_WORKER_URL } from '@shared/ipc'
import { mainLog, auditLog } from './logger'
import { decryptEmbeddedBlob, type EncryptedCloudflareKeyBlob } from './embedded-cloudflare-crypto'

// A proxy key OR a Cloudflare account token (cfut_… / a scoped API token). Both are >= 20 chars of
// URL/base64-ish characters; the shape check only rejects obvious garbage, never a specific vendor format.
const PROXY_KEY_PATTERN = /^[A-Za-z0-9+/_=-]{20,}$/

/** The decrypted embedded credential: always a token, plus an optional direct-Cloudflare endpoint. */
export interface EmbeddedCloudflareCredential {
  token: string
  /** The account-scoped REST endpoint for the DIRECT shape, or null for the Worker-proxy shape. */
  baseUrl: string | null
}

/** Per-profile marker recording the one-time embedded-key seed already ran (mirrors cahe-embedded-key.ts). */
function seededMarkerPath(): string {
  return join(app.getPath('userData'), '.cloudflare-key-seeded')
}

/** Absolute path of the packaged encrypted blob (ciphertext only — see the file header). */
function bundlePath(): string {
  return join(process.resourcesPath, 'cloudflare-embed', 'key.json')
}

/**
 * Interpret a decrypted plaintext payload. A JSON object with a string `token` is the DIRECT shape and may
 * carry an https `baseUrl`; anything else is treated as a bare Worker proxy key. Returns null when no
 * usable token can be recovered. Never throws.
 */
function parseCredentialPlaintext(plaintext: string): EmbeddedCloudflareCredential | null {
  const raw = plaintext.trim()
  if (!raw) return null
  if (raw.startsWith('{')) {
    try {
      const obj = JSON.parse(raw) as { token?: unknown; baseUrl?: unknown }
      const token = typeof obj.token === 'string' ? obj.token.trim() : ''
      if (!PROXY_KEY_PATTERN.test(token)) return null
      const baseUrl =
        typeof obj.baseUrl === 'string' && /^https:\/\//i.test(obj.baseUrl.trim())
          ? obj.baseUrl.trim().replace(/\/+$/, '')
          : null
      return { token, baseUrl }
    } catch {
      return null // looked like JSON, wasn't — do not fall through and send `{…}` as a bearer token
    }
  }
  if (!PROXY_KEY_PATTERN.test(raw)) return null
  return { token: raw, baseUrl: null }
}

/**
 * Read the packaged blob and DECRYPT it in memory, returning the embedded credential or null. Null covers
 * every "nothing usable here" case identically — no bundle (the normal keyless build), unreadable/corrupt
 * JSON, a blob encrypted under different material, a tampered blob that fails GCM auth, or a decrypted
 * value that does not look like a credential. Never throws; never logs the plaintext.
 */
function readEmbeddedCredential(): EmbeddedCloudflareCredential | null {
  try {
    const p = bundlePath()
    if (!existsSync(p)) return null // keyless build: no bundle to decrypt
    const blob = JSON.parse(readFileSync(p, 'utf8')) as EncryptedCloudflareKeyBlob
    const plaintext = decryptEmbeddedBlob(blob)
    if (!plaintext) return null
    return parseCredentialPlaintext(plaintext)
  } catch (e) {
    mainLog.warn('[embedded-cloudflare-key] could not read/decrypt the embedded blob', e)
    return null
  }
}

/**
 * Apply the direct-Cloudflare endpoint from an embedded credential, but ONLY when the profile still holds
 * the shipped default Worker URL — never clobber an endpoint an operator set through managed config or a
 * user typed in Settings. A no-op for the Worker-proxy shape (baseUrl null).
 */
function seedEmbeddedBaseUrl(cred: EmbeddedCloudflareCredential): void {
  if (!cred.baseUrl) return
  try {
    if (getSettings().cloudflareBaseUrl === METIS_WORKER_URL) {
      setSettings({ cloudflareBaseUrl: cred.baseUrl })
    }
  } catch (e) {
    mainLog.warn('[embedded-cloudflare-key] could not seed the embedded Cloudflare endpoint', e)
  }
}

/**
 * Seed the bundled Cloudflare credential (key into the encrypted keystore, endpoint into settings) exactly
 * once per profile. Best-effort only — never throws, never logs the key value itself. A build with no
 * bundle (the normal, un-embedded case) is a silent no-op: normal onboarding is untouched.
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

  const cred = readEmbeddedCredential()
  if (!cred) {
    // Keyless build, or a malformed/undecryptable bundle: leave the marker unwritten so a corrected build
    // can still seed on a later launch, and leave normal onboarding in place.
    return
  }

  try {
    setApiKey('cloudflare', cred.token)
    seedEmbeddedBaseUrl(cred)
    auditLog('key.set', { provider: 'cloudflare', source: 'embedded-default' })
    mainLog.info('[embedded-cloudflare-key] seeded the embedded Cloudflare credential')
  } catch (e) {
    // Keystore error — never block startup, and never burn the marker so a later launch can retry.
    mainLog.warn('[embedded-cloudflare-key] embedded key import failed', e)
    return
  }

  try {
    writeFileSync(marker, new Date().toISOString(), { mode: 0o600 })
  } catch (e) {
    mainLog.warn('[embedded-cloudflare-key] could not write the seed marker', e)
  }
}

/**
 * Is there a shipped credential this install could fall back on? Reads and DECRYPTS the bundle only — it
 * says nothing about whether the keystore currently holds a key, which is deliberately the renderer's
 * other question.
 *
 * A keyless build (the normal case) answers false, so the restore affordance never appears where there is
 * nothing to restore.
 */
export function embeddedCloudflareKeyAvailable(): boolean {
  return readEmbeddedCredential() !== null
}

/**
 * Put the shipped credential back, at the user's explicit request (MQA-261).
 *
 * This deliberately ignores the seed marker, and that is not a hole in it. The marker's job is to stop a
 * LAUNCH silently overwriting a key the user chose — it protects the user's intent against the app. Here
 * the user IS the one asking, so there is no intent to protect; refusing would be the app overruling them.
 *
 * Why it has to exist: onboarding hands a fresh install a working Cloudflare key nobody typed, so the user
 * never had a copy. One unconfirmed click on the trash icon then removed the only credential they had, the
 * marker meant it never came back, and the Settings copy told them to paste a key they were never given.
 * Every ask fell to the on-device model — measured at 12.2s against ~0.9s — with nothing on screen
 * explaining why the product had become slow.
 */
export function restoreEmbeddedCloudflareKey(): { ok: boolean; error?: string } {
  const p = bundlePath()
  if (!existsSync(p)) {
    return { ok: false, error: 'This build did not ship a Cloudflare key, so there is nothing to restore.' }
  }
  const cred = readEmbeddedCredential()
  if (!cred) {
    return { ok: false, error: 'The key that shipped with this build is unreadable, so it was not restored.' }
  }

  try {
    setApiKey('cloudflare', cred.token)
    seedEmbeddedBaseUrl(cred)
  } catch (e) {
    mainLog.warn('[embedded-cloudflare-key] restore could not write the keystore', e)
    return { ok: false, error: 'The key could not be saved to this profile.' }
  }

  // Distinct from the seed's own 'embedded-default' so the audit trail separates "the installer set this"
  // from "the user asked for it back" — they answer different questions after the fact.
  auditLog('key.set', { provider: 'cloudflare', source: 'embedded-default-restored' })
  mainLog.info('[embedded-cloudflare-key] restored the embedded Cloudflare credential on an explicit request')
  return { ok: true }
}
