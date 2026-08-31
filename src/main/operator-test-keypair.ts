/**
 * Runtime-only Ed25519 fixtures for Operator tests. The private key is created in-process
 * and never written to the repo. Do not add a PEM block to git.
 */
import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto'
import type { OperatorSkillPack } from './operator-skill-verify'

export function generateOperatorTestKeypair(): { privateKeyPem: string; publicKeyRaw: string } {
  const pair = generateKeyPairSync('ed25519')
  const jwk = pair.publicKey.export({ format: 'jwk' }) as { x?: string }
  if (typeof jwk.x !== 'string' || !jwk.x) throw new Error('ed25519 jwk missing x')
  return {
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyRaw: jwk.x
  }
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function sha256HexUtf8Body(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

/** Same compact token as operator/src/crypto.ts signSkillPack. */
export function signOperatorSkillPackForTests(payload: OperatorSkillPack, privateKeyPem: string): string {
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), 'utf8'))
  const sig = sign(null, Buffer.from(payloadB64, 'utf8'), createPrivateKey(privateKeyPem))
  return `${payloadB64}.${b64url(sig)}`
}
