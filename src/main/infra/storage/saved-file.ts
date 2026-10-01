import { safeStorage } from 'electron'
import { rename, unlink, writeFile } from 'node:fs/promises'
import { constants, createCipheriv, createDecipheriv, publicEncrypt, randomBytes } from 'node:crypto'
import { encryptSecret, decryptSecret, useFileBackend } from '../../secrets'
import { readTrustedAdminManaged } from '../../win-security'
import { mainLog, auditLog } from '../../logger'
import { devEnv, isPackagedBuild } from '../../dev-env'

const ENC_MARKER = Buffer.from('ATKENC1\n')
const ENC_MARKER_V2 = Buffer.from('ATKENC2\n')
const MARKER_LEN = ENC_MARKER.length
const OSCRYPT_V10_PREFIX = Buffer.from('v10', 'utf8')
const OSCRYPT_V10_MIN_INDEXABLE = OSCRYPT_V10_PREFIX.length + 12

type EnvelopeV2 = {
  v: 2
  iv: string
  tag: string
  ct: string
  kLocal: string
  kEscrow?: string
}

export type SavedDecode = { ok: true; text: string } | { ok: false; reason: string }

function unwrapWithKeychain(blob: Buffer): string {
  if (blob.length === 0) throw new Error('wrapped key is empty')
  if (blob.subarray(0, OSCRYPT_V10_PREFIX.length).equals(OSCRYPT_V10_PREFIX) && blob.length < OSCRYPT_V10_MIN_INDEXABLE) {
    throw new Error('wrapped key is a truncated OSCrypt v10 blob')
  }
  return safeStorage.decryptString(blob)
}

function resolveEscrowPem(raw: string | null | undefined): string | null {
  const value = (raw || '').trim()
  if (!value) return null
  if (value.includes('-----BEGIN')) return value
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8')
    return decoded.includes('-----BEGIN') ? decoded : null
  } catch {
    return null
  }
}

function escrowFromManagedContent(raw: string): string | null {
  try {
    const obj = JSON.parse(raw)
    return typeof obj?.escrowPubKey === 'string' ? obj.escrowPubKey : null
  } catch {
    return null
  }
}

let warnedIgnoredEscrowEnv = false

function readEscrowPubKey(): string | null {
  const fromEnv = resolveEscrowPem(devEnv('ASKTOTO_ESCROW_PUBKEY'))
  if (fromEnv) return fromEnv
  if (!warnedIgnoredEscrowEnv && process.env.ASKTOTO_ESCROW_PUBKEY && isPackagedBuild()) {
    warnedIgnoredEscrowEnv = true
    mainLog.warn(
      'Métis: ASKTOTO_ESCROW_PUBKEY is a dev-only switch and is ignored in a packaged build; set escrowPubKey in the machine-wide managed-config instead'
    )
  }
  try {
    const admin = readTrustedAdminManaged()
    return admin ? resolveEscrowPem(escrowFromManagedContent(admin)) : null
  } catch {
    return null
  }
}

function encryptEnvelopeV2(content: string): Buffer {
  const contentKey = randomBytes(32)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', contentKey, iv)
  const ct = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()])
  const env: EnvelopeV2 = {
    v: 2,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
    kLocal:
      !useFileBackend() && safeStorage.isEncryptionAvailable()
        ? 'S:' + safeStorage.encryptString(contentKey.toString('base64')).toString('base64')
        : 'F:' + encryptSecret(contentKey.toString('base64')).toString('base64')
  }
  const pem = readEscrowPubKey()
  if (pem) {
    try {
      env.kEscrow = publicEncrypt(
        { key: pem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        contentKey
      ).toString('base64')
    } catch {
      mainLog.warn('Métis: escrow public key configured but unusable; wrote saved file without escrow wrap')
      auditLog('transcript.saved', { escrowFailed: true })
    }
  }
  return Buffer.concat([ENC_MARKER_V2, Buffer.from(JSON.stringify(env), 'utf8')])
}

function decryptEnvelopeV2(buf: Buffer): string {
  const env = JSON.parse(buf.subarray(MARKER_LEN).toString('utf8')) as EnvelopeV2
  const rawKey = env.kLocal.startsWith('F:')
    ? decryptSecret(Buffer.from(env.kLocal.slice(2), 'base64'))
    : unwrapWithKeychain(Buffer.from(env.kLocal.startsWith('S:') ? env.kLocal.slice(2) : env.kLocal, 'base64'))
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(rawKey, 'base64'), Buffer.from(env.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]).toString('utf8')
}

export function decodeSavedResult(buf: Buffer): SavedDecode {
  if (buf.length >= MARKER_LEN && buf.subarray(0, MARKER_LEN).equals(ENC_MARKER_V2)) {
    try {
      return { ok: true, text: decryptEnvelopeV2(buf) }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }
  if (buf.length >= ENC_MARKER.length && buf.subarray(0, ENC_MARKER.length).equals(ENC_MARKER)) {
    if (process.env.ASKTOTO_LOCAL_KEYSTORE) {
      return { ok: false, reason: 'keychain-wrapped saved file is unavailable while the local keystore is active' }
    }
    try {
      return { ok: true, text: unwrapWithKeychain(buf.subarray(ENC_MARKER.length)) }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }
  return { ok: true, text: buf.toString('utf8') }
}

export function decodeSaved(buf: Buffer): string {
  const decoded = decodeSavedResult(buf)
  return decoded.ok ? decoded.text : ''
}

export async function writeEncryptedSavedFile(file: string, content: string): Promise<void> {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(tmp, encryptEnvelopeV2(content), { mode: 0o600 })
    await rename(tmp, file)
  } catch (error) {
    await unlink(tmp).catch(() => undefined)
    throw error
  }
}
