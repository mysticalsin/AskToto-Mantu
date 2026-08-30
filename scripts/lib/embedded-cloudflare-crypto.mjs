// embedded-cloudflare-crypto.mjs — the ONE build-time implementation of the encrypt/decrypt used for the
// optional installer-embedded Cloudflare proxy key (docs/CLOUDFLARE.md). Imported by:
//   - scripts/embed-cloudflare-key.mjs        (build step: METIS_PROXY_KEY -> encrypted blob)
//   - scripts/check-embedded-cloudflare-key.mjs (packaging gate: proves the blob is ciphertext + no plaintext leak)
//   - scripts/check-cloudflare-key-valid.mjs   (pre-ship probe: decrypts, then asks the Worker if the key works)
//   - the vitest suite                          (round-trip / tamper / no-plaintext against the SHIPPED decryptor)
//
// The RUNTIME decryptor lives in src/main/embedded-cloudflare-key.ts as a separate copy (it must be a
// static-import, bytecode-safe TS module — see docs/DEVELOPMENT.md). Both copies read the SAME parameters
// from src/main/embedded-key-material.json, and a cross-implementation round-trip test (embedded-cloudflare-
// crypto.test.ts) encrypts here and decrypts there, so the two can never silently drift.
//
// SECURITY HONESTY: the passphrase (appId + obfuscationSecret) and the KDF/cipher parameters all ship
// inside the app, so this is OBFUSCATION, not secrecy — a determined attacker with the binary can re-derive
// the key and decrypt the blob. It only raises the bar over a plaintext file. The token-never-ships option
// is the Worker proxy. Do not overclaim this "cannot be reverse engineered".
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MATERIAL_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'main', 'embedded-key-material.json')

/** Load and lightly validate the shared obfuscation material. Throws loudly on anything malformed — a
 *  silently-wrong parameter would produce a blob the runtime cannot decrypt, which is worse than failing. */
export function loadMaterial() {
  const m = JSON.parse(readFileSync(MATERIAL_PATH, 'utf8'))
  if (m.algorithm !== 'aes-256-gcm') throw new Error(`embedded-key-material.json: unexpected algorithm "${m.algorithm}"`)
  if (m.kdf !== 'scrypt') throw new Error(`embedded-key-material.json: unexpected kdf "${m.kdf}"`)
  if (typeof m.appId !== 'string' || !m.appId) throw new Error('embedded-key-material.json: missing appId')
  if (typeof m.obfuscationSecret !== 'string' || m.obfuscationSecret.length < 16) {
    throw new Error('embedded-key-material.json: obfuscationSecret missing or too short')
  }
  return m
}

/** Derive the 32-byte AES key from build-stable material (appId + obfuscation secret) + a per-blob salt. */
function deriveKey(material, salt) {
  const { N, r, p, keylen, maxmem } = material.scrypt
  const passphrase = `${material.appId}\u001f${material.obfuscationSecret}`
  return scryptSync(passphrase, salt, keylen, { N, r, p, maxmem })
}

/**
 * Encrypt a plaintext proxy key into the on-disk blob shape the app decrypts at runtime. Every field is
 * base64; the salt and iv are fresh random per call so two builds of the same token never produce the same
 * ciphertext. The GCM auth tag + AAD bind the blob so any tamper (a flipped byte, a swapped field) fails
 * the runtime decrypt instead of yielding a wrong-but-plausible key.
 */
export function encryptProxyKey(plaintext, materialOverride) {
  const material = materialOverride ?? loadMaterial()
  const trimmed = String(plaintext ?? '').trim()
  if (!trimmed) throw new Error('encryptProxyKey: refusing to encrypt an empty token')
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = deriveKey(material, salt)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(material.aad, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(trimmed, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    version: material.version,
    alg: material.algorithm,
    kdf: material.kdf,
    // Loud, machine-and-human-readable disclosure that the blob is obfuscated, not secret.
    note: 'obfuscated (extractable with effort) — not a secret; see docs/CLOUDFLARE.md',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64')
  }
}

/** Decrypt a blob produced by encryptProxyKey back to the plaintext proxy key. Throws on tamper/bad key. */
export function decryptProxyKey(blob, materialOverride) {
  const material = materialOverride ?? loadMaterial()
  if (!blob || typeof blob !== 'object') throw new Error('decryptProxyKey: blob is not an object')
  for (const f of ['salt', 'iv', 'tag', 'ciphertext']) {
    if (typeof blob[f] !== 'string' || !blob[f]) throw new Error(`decryptProxyKey: blob missing "${f}"`)
  }
  const salt = Buffer.from(blob.salt, 'base64')
  const iv = Buffer.from(blob.iv, 'base64')
  const tag = Buffer.from(blob.tag, 'base64')
  const ciphertext = Buffer.from(blob.ciphertext, 'base64')
  const key = deriveKey(material, salt)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(Buffer.from(material.aad, 'utf8'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/** True when a parsed blob has the encrypted shape (and NO plaintext `proxyKey` field). Cheap structural
 *  check used by the packaging gate before it attempts a real decrypt. */
export function isEncryptedBlob(blob) {
  return (
    !!blob &&
    typeof blob === 'object' &&
    typeof blob.ciphertext === 'string' &&
    typeof blob.iv === 'string' &&
    typeof blob.tag === 'string' &&
    typeof blob.salt === 'string' &&
    blob.alg === 'aes-256-gcm' &&
    !('proxyKey' in blob)
  )
}
