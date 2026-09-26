/**
 * Verify Operator skill packs. Same compact token as operator/src/crypto.ts:
 *   base64url(JSON payload).base64url(ed25519 sig)
 * Signature covers the payload base64url ASCII bytes (not re-serialized JSON).
 */
import { createPublicKey, verify } from 'node:crypto'
import { createHash } from 'node:crypto'
import { getOperatorSkillPublicKeyRaw } from './operator-skill-key'

export interface OperatorSkillPack {
  skillId: string
  version: string
  sha256: string
  body: string
}

function b64urlToBuf(s: string): Buffer {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(pad + '='.repeat((4 - (pad.length % 4)) % 4), 'base64')
}

function isPack(v: unknown): v is OperatorSkillPack {
  if (!v || typeof v !== 'object') return false
  const p = v as Record<string, unknown>
  return (
    typeof p.skillId === 'string' &&
    typeof p.version === 'string' &&
    typeof p.sha256 === 'string' &&
    typeof p.body === 'string'
  )
}

export function verifyOperatorSkillPack(
  token: string,
  publicKeyRaw?: string
): OperatorSkillPack | null {
  let keyRaw: string
  try {
    keyRaw = publicKeyRaw ?? getOperatorSkillPublicKeyRaw()
  } catch {
    // Packaged builds without a production pubkey throw — fail closed without crashing the overlay.
    return null
  }
  const dot = token.indexOf('.')
  if (dot <= 0 || token.indexOf('.', dot + 1) !== -1) return null
  const payloadB64 = token.slice(0, dot)
  const sigB64 = token.slice(dot + 1)
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: keyRaw }, format: 'jwk' })
    const ok = verify(null, Buffer.from(payloadB64, 'utf8'), key, b64urlToBuf(sigB64))
    if (!ok) return null
    const parsed = JSON.parse(b64urlToBuf(payloadB64).toString('utf8')) as unknown
    if (!isPack(parsed)) return null
    const digest = createHash('sha256').update(parsed.body, 'utf8').digest('hex')
    if (digest !== parsed.sha256) return null
    return parsed
  } catch {
    return null
  }
}
