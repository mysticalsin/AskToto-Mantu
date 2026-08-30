/**
 * embedded-cloudflare-crypto.ts — the RUNTIME decryptor for the optional installer-embedded Cloudflare
 * proxy key (docs/CLOUDFLARE.md). This is the shipped counterpart of the build-time encryptor in
 * scripts/lib/embedded-cloudflare-crypto.mjs; both read the SAME parameters from embedded-key-material.json,
 * and embedded-cloudflare-crypto.test.ts encrypts with the script and decrypts here so the two can never
 * silently drift.
 *
 * Bytecode-safe by construction (docs/DEVELOPMENT.md): node:crypto and the material JSON are STATIC
 * top-level imports — no dynamic import(), which throws under the bytecode-compiled main.
 *
 * SECURITY HONESTY: the passphrase (appId + obfuscationSecret) ships inside the app, so this is
 * OBFUSCATION, not secrecy. Anyone with the binary can re-derive the key and decrypt the blob — it only
 * raises the bar above a plaintext file. The token-never-ships option is the Worker proxy. Do NOT claim
 * this "cannot be reverse engineered".
 */
import { createDecipheriv, scryptSync } from 'node:crypto'
import material from './embedded-key-material.json'

export interface EncryptedCloudflareKeyBlob {
  version?: number
  alg?: string
  kdf?: string
  note?: string
  salt?: string
  iv?: string
  tag?: string
  ciphertext?: string
}

function deriveKey(salt: Buffer): Buffer {
  const { N, r, p, keylen, maxmem } = material.scrypt
  const passphrase = `${material.appId}\u001f${material.obfuscationSecret}`
  return scryptSync(passphrase, salt, keylen, { N, r, p, maxmem })
}

/**
 * Decrypt an encrypted blob back to the plaintext proxy key. Returns the key string on success, or null if
 * the blob is missing fields, is not the encrypted shape, or fails GCM authentication (tampered/corrupt, or
 * produced under different material). NEVER throws — callers run at startup and must degrade to normal
 * onboarding, never crash. NEVER logs the plaintext.
 */
export function decryptEmbeddedBlob(blob: EncryptedCloudflareKeyBlob | null | undefined): string | null {
  if (!blob || typeof blob !== 'object') return null
  const { salt, iv, tag, ciphertext } = blob
  if (!salt || !iv || !tag || !ciphertext) return null
  try {
    const key = deriveKey(Buffer.from(salt, 'base64'))
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
    decipher.setAAD(Buffer.from(material.aad, 'utf8'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    const out = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()])
    const plaintext = out.toString('utf8').trim()
    return plaintext || null
  } catch {
    // Wrong material, tampered ciphertext, or a corrupt blob — indistinguishable and all mean "unusable".
    return null
  }
}
