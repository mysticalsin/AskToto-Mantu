/** AES-GCM prompt encryption + Ed25519 skill-pack signatures. WebCrypto only. */

const enc = new TextEncoder()
const dec = new TextDecoder()

export function bytesToB64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function b64urlToBytes(b64url: string): Uint8Array {
  const pad = b64url.replace(/-/g, '+').replace(/_/g, '/')
  const padded = pad + '='.repeat((4 - (pad.length % 4)) % 4)
  return b64ToBytes(padded)
}

export function bytesToB64url(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const buf = typeof data === 'string' ? enc.encode(data) : data
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf))
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export { sha256Hex }

function decodePromptKey(raw: string): Uint8Array {
  const trimmed = raw.trim()
  try {
    const bytes = b64ToBytes(trimmed)
    if (bytes.length === 32) return bytes
  } catch {
    /* fall through */
  }
  throw new Error('OPERATOR_PROMPT_KEY must be 32 bytes, base64')
}

export async function encryptPrompt(
  plaintext: string,
  keyRaw: string
): Promise<{ cipher: string; iv: string }> {
  const keyBytes = decodePromptKey(keyRaw)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt'])
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext)))
  return { cipher: bytesToB64(cipher), iv: bytesToB64(iv) }
}

export async function decryptPrompt(cipher: string, iv: string, keyRaw: string): Promise<string> {
  const keyBytes = decodePromptKey(keyRaw)
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt'])
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(iv) },
    key,
    b64ToBytes(cipher)
  )
  return dec.decode(plain)
}

export interface SkillPackPayload {
  skillId: string
  version: string
  sha256: string
  body: string
}

export async function signSkillPack(payload: SkillPackPayload, privateKeyPkcs8Pem: string): Promise<string> {
  const pem = privateKeyPkcs8Pem.includes('BEGIN')
    ? privateKeyPkcs8Pem
    : atob(privateKeyPkcs8Pem)
  const pkcs8 = pemToPkcs8(pem)
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign'])
  const payloadB64 = bytesToB64url(enc.encode(JSON.stringify(payload)))
  const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', key, enc.encode(payloadB64)))
  return `${payloadB64}.${bytesToB64url(sig)}`
}

export async function verifySkillPack(token: string, publicKeyRaw: string): Promise<SkillPackPayload | null> {
  const dot = token.indexOf('.')
  if (dot <= 0 || token.indexOf('.', dot + 1) !== -1) return null
  const payloadB64 = token.slice(0, dot)
  const sigB64 = token.slice(dot + 1)
  try {
    const x = b64urlToBytes(publicKeyRaw)
    const key = await crypto.subtle.importKey('raw', x, { name: 'Ed25519' }, false, ['verify'])
    const ok = await crypto.subtle.verify('Ed25519', key, b64urlToBytes(sigB64), enc.encode(payloadB64))
    if (!ok) return null
    const parsed = JSON.parse(dec.decode(b64urlToBytes(payloadB64))) as SkillPackPayload
    if (!parsed?.skillId || !parsed.version || !parsed.sha256 || typeof parsed.body !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/, '').replace(/-----END [^-]+-----/, '').replace(/\s+/g, '')
  return b64ToBytes(b64).buffer
}
