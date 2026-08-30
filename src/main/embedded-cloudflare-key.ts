/**
 * embedded-cloudflare-key.ts — optional installer-embedded METIS_PROXY_KEY, so a fresh install can talk
 * to the operator's Cloudflare Worker (the default provider, see ipc.ts's BaseSettingsSchema.provider)
 * with zero paste-a-key setup.
 *
 * WHAT SHIPS IN THE INSTALLER IS AN ENCRYPTED BLOB, NOT THE PLAINTEXT KEY. The build step
 * (scripts/embed-cloudflare-key.mjs) AES-256-GCM-encrypts the operator's METIS_PROXY_KEY under a key
 * derived (scrypt) from build-stable material (appId + an obfuscation secret in embedded-key-material.json)
 * and writes only the ciphertext blob to build/cloudflare-embed/key.json, which electron-builder copies to
 * resources/cloudflare-embed/key.json. At runtime this module reads that blob and decrypts it IN MEMORY
 * (decryptEmbeddedBlob, static-import + bytecode-safe — docs/DEVELOPMENT.md). The decrypted plaintext is
 * never written to disk or logs; what lands on disk is only ever the app's OWN encrypted keystore blob
 * (store.ts's setApiKey, AES file keystore — the exact same at-rest encryption a user-pasted key gets).
 *
 * SECURITY HONESTY (do not soften this): encrypting a key with material that ALSO ships in the app is
 * OBFUSCATION, not secrecy. A determined attacker with the binary can re-derive the key and decrypt the
 * blob — this only raises the bar above a plaintext file that `npx asar extract` reads in seconds. The
 * truly-secure option, where the token never ships at all, is the Worker proxy (docs/CLOUDFLARE.md). What
 * makes an embedded key safe to ship is its SCOPE, not this encryption:
 *   - it is provisioned into the Worker's METIS_PROXY_KEYS array under its own "embedded-default" label
 *     (cloudflare-proxy/src/index.ts's multi-key union), never as METIS_PROXY_KEY (the operator's own key);
 *   - a labeled key is revoked independently, by removing its entry, without touching any other user's key;
 *   - the operator sizes it as a minimum-quota fallback, not a shared admin credential.
 *
 * This module only SEEDS the decrypted key into the app's own encrypted keystore (store.ts's setApiKey)
 * once per profile, tracked by a marker file so a user's later key change/removal always sticks and is
 * never silently re-overwritten on the next launch.
 */
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getApiKey, setApiKey } from './store'
import { mainLog, auditLog } from './logger'
import { decryptEmbeddedBlob, type EncryptedCloudflareKeyBlob } from './embedded-cloudflare-crypto'

const PROXY_KEY_PATTERN = /^[A-Za-z0-9+/_=-]{20,}$/

/** Per-profile marker recording the one-time embedded-key seed already ran (mirrors cahe-embedded-key.ts). */
function seededMarkerPath(): string {
  return join(app.getPath('userData'), '.cloudflare-key-seeded')
}

/** Absolute path of the packaged encrypted blob (ciphertext only — see the file header). */
function bundlePath(): string {
  return join(process.resourcesPath, 'cloudflare-embed', 'key.json')
}

/**
 * Read the packaged blob and DECRYPT it in memory, returning the plaintext proxy key or null. Null covers
 * every "nothing usable here" case identically — no bundle (the normal keyless build), unreadable/corrupt
 * JSON, a blob encrypted under different material, a tampered blob that fails GCM auth, or a decrypted
 * value that does not look like a proxy key. Never throws; never logs the plaintext.
 */
function readEmbeddedProxyKey(): string | null {
  try {
    const p = bundlePath()
    if (!existsSync(p)) return null // keyless build: no bundle to decrypt
    const blob = JSON.parse(readFileSync(p, 'utf8')) as EncryptedCloudflareKeyBlob
    const key = decryptEmbeddedBlob(blob)?.trim()
    if (!key || !PROXY_KEY_PATTERN.test(key)) return null
    return key
  } catch (e) {
    mainLog.warn('[embedded-cloudflare-key] could not read/decrypt the embedded blob', e)
    return null
  }
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

  const key = readEmbeddedProxyKey()
  if (!key) {
    // Keyless build, or a malformed/undecryptable bundle: leave the marker unwritten so a corrected build
    // can still seed on a later launch, and leave normal onboarding in place.
    return
  }

  try {
    setApiKey('cloudflare', key)
    auditLog('key.set', { provider: 'cloudflare', source: 'embedded-default' })
    mainLog.info('[embedded-cloudflare-key] seeded the embedded Cloudflare proxy key')
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
 * Is there a shipped key this install could fall back on? Reads and DECRYPTS the bundle only — it says
 * nothing about whether the keystore currently holds a key, which is deliberately the renderer's other
 * question.
 *
 * A keyless build (the normal case) answers false, so the restore affordance never appears where there is
 * nothing to restore.
 */
export function embeddedCloudflareKeyAvailable(): boolean {
  return readEmbeddedProxyKey() !== null
}

/**
 * Put the shipped key back, at the user's explicit request (MQA-261).
 *
 * This deliberately ignores the seed marker, and that is not a hole in it. The marker's job is to stop a
 * LAUNCH silently overwriting a key the user chose — it protects the user's intent against the app. Here
 * the user IS the one asking, so there is no intent to protect; refusing would be the app overruling them.
 *
 * Why it has to exist: onboarding hands a fresh install a working Cloudflare key nobody typed, so the user
 * never had a copy. One unconfirmed click on the trash icon then removed the only credential they had, the
 * marker meant it never came back, and the Settings copy told them to paste a METIS_PROXY_KEY they were
 * never given. Every ask fell to the on-device model — measured at 12.2s against ~0.9s through the Worker —
 * with nothing on screen explaining why the product had become slow.
 */
export function restoreEmbeddedCloudflareKey(): { ok: boolean; error?: string } {
  const p = bundlePath()
  if (!existsSync(p)) {
    return { ok: false, error: 'This build did not ship a Cloudflare key, so there is nothing to restore.' }
  }
  const key = readEmbeddedProxyKey()
  if (!key) {
    return { ok: false, error: 'The key that shipped with this build is unreadable, so it was not restored.' }
  }

  try {
    setApiKey('cloudflare', key)
  } catch (e) {
    mainLog.warn('[embedded-cloudflare-key] restore could not write the keystore', e)
    return { ok: false, error: 'The key could not be saved to this profile.' }
  }

  // Distinct from the seed's own 'embedded-default' so the audit trail separates "the installer set this"
  // from "the user asked for it back" — they answer different questions after the fact.
  auditLog('key.set', { provider: 'cloudflare', source: 'embedded-default-restored' })
  mainLog.info('[embedded-cloudflare-key] restored the embedded Cloudflare proxy key on an explicit request')
  return { ok: true }
}
