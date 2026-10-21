import { createCipheriv, createDecipheriv } from 'node:crypto'

/**
 * Inline (main-thread) ATKENC2 envelope codec. It produces and accepts exactly the bytes the isolated meeting
 * speech worker does (`meeting-speech-worker.ts` encrypt-v2 / decrypt-v2 / rewrap-v2), so the async wrappers in
 * `meeting-speech.ts` can fall back to it when the worker is absent, busy or failed without changing a saved file.
 * The caller owns (and wipes) the key and IV buffers it passes in; this module never keeps a copy.
 */

const MARKER = Buffer.from('ATKENC2\n')
const B64 = /^[A-Za-z0-9+/]+={0,2}$/
const B64_OR_EMPTY = /^[A-Za-z0-9+/]*={0,2}$/

interface ParsedEnvelope {
  v: 2
  iv: string
  tag: string
  ct: string
  kLocal: string
  kEscrow?: string
}

function parseEnvelope(envelopeJson: Uint8Array): ParsedEnvelope {
  const envelope = JSON.parse(Buffer.from(envelopeJson).toString('utf8')) as Record<string, unknown>
  const keys = Object.keys(envelope).sort().join(',')
  if (
    (keys !== 'ct,iv,kLocal,tag,v' && keys !== 'ct,iv,kEscrow,kLocal,tag,v') ||
    envelope.v !== 2 ||
    typeof envelope.iv !== 'string' ||
    typeof envelope.tag !== 'string' ||
    typeof envelope.ct !== 'string' ||
    typeof envelope.kLocal !== 'string' ||
    (envelope.kEscrow !== undefined && typeof envelope.kEscrow !== 'string') ||
    !B64.test(envelope.iv) ||
    !B64.test(envelope.tag) ||
    !B64_OR_EMPTY.test(envelope.ct)
  )
    throw new Error('Envelope is not a valid v2 envelope.')
  return envelope as unknown as ParsedEnvelope
}

export function encryptMeetingEnvelopeInline(
  content: string,
  contentKey: Uint8Array,
  iv: Uint8Array,
  kLocal: string,
  kEscrow?: string
): Buffer {
  if (contentKey.byteLength !== 32 || iv.byteLength !== 12) throw new Error('Envelope key material is invalid.')
  const cipher = createCipheriv('aes-256-gcm', contentKey, iv)
  const ciphertext = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()])
  const envelope = {
    v: 2,
    iv: Buffer.from(iv).toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ciphertext.toString('base64'),
    kLocal,
    ...(typeof kEscrow === 'string' ? { kEscrow } : {})
  }
  return Buffer.concat([MARKER, Buffer.from(JSON.stringify(envelope), 'utf8')])
}

export function decryptMeetingEnvelopeInline(
  envelopeJson: Uint8Array,
  contentKey: Uint8Array,
  kLocal: string
): string {
  if (contentKey.byteLength !== 32) throw new Error('Envelope key material is invalid.')
  const envelope = parseEnvelope(envelopeJson)
  if (envelope.kLocal !== kLocal) throw new Error('Envelope key field does not match.')
  const iv = Buffer.from(envelope.iv, 'base64')
  const tag = Buffer.from(envelope.tag, 'base64')
  if (iv.byteLength !== 12 || tag.byteLength !== 16) throw new Error('Envelope is not a valid v2 envelope.')
  const decipher = createDecipheriv('aes-256-gcm', contentKey, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]).toString('utf8')
}

export function rewrapMeetingEnvelopeInline(envelopeJson: Uint8Array, kLocal: string): Buffer {
  const envelope = parseEnvelope(envelopeJson)
  envelope.kLocal = kLocal
  return Buffer.from(JSON.stringify(envelope), 'utf8')
}
