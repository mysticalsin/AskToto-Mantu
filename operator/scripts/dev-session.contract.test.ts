import { createHmac, hkdfSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  SESSION_COOKIE,
  base64OrUtf8Bytes,
  cookieHeaderLine,
  deriveSessionSecretNode,
  mintSessionTokenNode,
  parseArgs,
  parseDevVars
} from './dev-session.mjs'

/** Independent re-derivation using Node's native `crypto.hkdfSync`/`createHmac` — a different API
 * surface than the script's `crypto.subtle` calls — so a pass here means two separate
 * implementations of the access.ts algorithm agree, not just that the script agrees with itself. */
async function referenceDeriveSecret(promptKeyB64) {
  const keyMaterial = Buffer.from(promptKeyB64, 'base64')
  const bits = hkdfSync('sha256', keyMaterial, Buffer.alloc(0), Buffer.from('metis-operator-session'), 32)
  return Buffer.from(bits).toString('hex')
}

function referenceHmacHex(secret, message) {
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(message, 'utf8').digest('hex')
}

describe('base64OrUtf8Bytes', () => {
  it('decodes valid base64', () => {
    const bytes = base64OrUtf8Bytes(Buffer.from('hello').toString('base64'))
    expect(Buffer.from(bytes).toString('utf8')).toBe('hello')
  })

  it('falls back to raw UTF-8 when the input is not base64-decodable by atob', () => {
    // atob throws on characters outside its base64 alphabet, e.g. an underscore-heavy raw secret.
    const raw = 'not_base64_at_all!!'
    const bytes = base64OrUtf8Bytes(raw)
    expect(Buffer.from(bytes).toString('utf8')).toBe(raw)
  })
})

describe('deriveSessionSecretNode', () => {
  const PROMPT_KEY_B64 = Buffer.alloc(32, 7).toString('base64')

  it('an explicit OPERATOR_SESSION_SECRET always wins over promptKey', async () => {
    const secret = await deriveSessionSecretNode({ explicit: 'my-explicit-secret', promptKey: PROMPT_KEY_B64 })
    expect(secret).toBe('my-explicit-secret')
  })

  it('returns undefined when neither is set', async () => {
    expect(await deriveSessionSecretNode({})).toBeUndefined()
  })

  it('matches an independent HKDF-SHA256 re-derivation via node:crypto', async () => {
    const scriptSecret = await deriveSessionSecretNode({ promptKey: PROMPT_KEY_B64 })
    const referenceSecret = await referenceDeriveSecret(PROMPT_KEY_B64)
    expect(scriptSecret).toBe(referenceSecret)
    expect(scriptSecret).toMatch(/^[0-9a-f]{64}$/) // 256 bits, hex
  })

  it('is deterministic for the same promptKey', async () => {
    const a = await deriveSessionSecretNode({ promptKey: PROMPT_KEY_B64 })
    const b = await deriveSessionSecretNode({ promptKey: PROMPT_KEY_B64 })
    expect(a).toBe(b)
  })
})

describe('mintSessionTokenNode', () => {
  it('produces v1|{iat}|{email}|{sig} with a lowercase email', async () => {
    const token = await mintSessionTokenNode('Tony.Walteur@Gmail.com', 1700000000000, 'deadbeef')
    const parts = token.split('|')
    expect(parts).toHaveLength(4)
    expect(parts[0]).toBe('v1')
    expect(parts[1]).toBe('1700000000000')
    expect(parts[2]).toBe('tony.walteur@gmail.com')
    expect(parts[3]).toMatch(/^[0-9a-f]{64}$/)
  })

  it('signature matches an independent HMAC-SHA256 re-derivation via node:crypto', async () => {
    const email = 'tony.walteur@gmail.com'
    const iat = 1700000000000
    const secret = 'some-derived-hex-secret'
    const token = await mintSessionTokenNode(email, iat, secret)
    const [, , , sig] = token.split('|')
    const payload = `v1|${iat}|${email}`
    const expected = referenceHmacHex(secret, `metis-operator-session:${payload}`)
    expect(sig).toBe(expected)
  })

  it('is deterministic for the same inputs (same iat can be re-derived, not rotated)', async () => {
    const a = await mintSessionTokenNode('x@y.com', 42, 'secret')
    const b = await mintSessionTokenNode('x@y.com', 42, 'secret')
    expect(a).toBe(b)
  })
})

describe('end-to-end: derive + mint matches a from-scratch reference implementation', () => {
  it('full pipeline agrees with independently computed HKDF + HMAC', async () => {
    const promptKeyB64 = Buffer.alloc(32, 42).toString('base64')
    const email = 'tony.walteur@gmail.com'
    const iat = 1735689600000

    const secret = await deriveSessionSecretNode({ promptKey: promptKeyB64 })
    const token = await mintSessionTokenNode(email, iat, secret)

    const referenceSecret = await referenceDeriveSecret(promptKeyB64)
    const referenceToken = `v1|${iat}|${email}|${referenceHmacHex(referenceSecret, `metis-operator-session:v1|${iat}|${email}`)}`

    expect(token).toBe(referenceToken)
  })
})

describe('cookieHeaderLine', () => {
  it('uses the exact SESSION_COOKIE name and URL-encodes the token', () => {
    const line = cookieHeaderLine('v1|1|a@b.com|abcd')
    expect(SESSION_COOKIE).toBe('metis_operator_session')
    expect(line).toBe(`Cookie: metis_operator_session=${encodeURIComponent('v1|1|a@b.com|abcd')}`)
  })

  it('never includes the word secret (nothing to leak from the cookie line itself)', () => {
    const line = cookieHeaderLine('v1|1|a@b.com|abcd')
    expect(line.toLowerCase()).not.toContain('secret')
  })
})

describe('parseDevVars', () => {
  it('parses simple KEY=VALUE lines, ignoring comments and blanks', () => {
    const parsed = parseDevVars(
      ['# comment', '', 'OPERATOR_PROMPT_KEY=abc123', 'OPERATOR_SESSION_SECRET="quoted value"', 'X=\'single\''].join(
        '\n'
      )
    )
    expect(parsed).toEqual({
      OPERATOR_PROMPT_KEY: 'abc123',
      OPERATOR_SESSION_SECRET: 'quoted value',
      X: 'single'
    })
  })

  it('returns an empty object for empty input', () => {
    expect(parseDevVars('')).toEqual({})
  })
})

describe('parseArgs', () => {
  it('defaults email and iat', () => {
    const args = parseArgs([])
    expect(args.email).toBe('tony.walteur@gmail.com')
    expect(typeof args.iat).toBe('number')
    expect(args.promptKey).toBeNull()
    expect(args.sessionSecret).toBeNull()
  })

  it('reads all flags', () => {
    const args = parseArgs(['--email', 'x@y.com', '--prompt-key', 'pk', '--session-secret', 'ss', '--iat', '123'])
    expect(args).toMatchObject({ email: 'x@y.com', promptKey: 'pk', sessionSecret: 'ss', iat: 123 })
  })
})
