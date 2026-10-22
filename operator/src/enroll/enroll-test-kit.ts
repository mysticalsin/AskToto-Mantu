/**
 * Test-only helpers for the enrolment suites (O01-O05): locally generated RSA keys, a stubbed JWKS transport
 * (no network), a signed `POST /v1/enroll` request builder and an Env with the SSO secrets set. Not imported
 * by any Worker code.
 */
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { ingestCanonical, OPERATOR_HMAC_HEADERS, OPERATOR_LICENSE_HEADER } from '../../../src/shared/operator-hmac'
import { sha256Hex } from '../crypto'
import { entraIssuer } from '../entra-idtoken'
import { hmacHex } from '../hmac'
import { handleRequest, type Env } from '../index'
import { createJwksCache, type JwksCache, type JwksFetch } from '../jwt-rs256'
import type { OperatorStore } from '../store'
import {
  TEST_ADMIN_EMAILS,
  TEST_INGEST_SECRET,
  TEST_OWNER_EMAIL,
  TEST_PROMPT_KEY,
  TEST_VAULT_KEY
} from '../test-fixtures'
import { createEnrollToken } from './tokens'

export const NOW = 1_800_000_000_000
export const TENANT = '11111111-2222-4333-8444-555555555555'
export const CLIENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
export const OID = '99999999-8888-4777-8666-555555555555'
export const DEVICE = 'enroll-device-0001'
export const DEVICE_2 = 'enroll-device-0002'
export const DEVICE_3 = 'enroll-device-0003'

export function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
    OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
    OPERATOR_SKILL_PRIVATE_KEY: '',
    OPERATOR_VAULT_KEY: TEST_VAULT_KEY,
    ADMIN_EMAILS: TEST_ADMIN_EMAILS,
    OWNER_EMAILS: TEST_OWNER_EMAIL,
    ENROLL_SSO_TENANT_ID: TENANT,
    ENROLL_SSO_CLIENT_IDS: CLIENT,
    ENROLL_SSO_ALLOWED_DOMAINS: 'example.test',
    ...overrides
  }
}

export interface SsoKit {
  mint(overrides?: Record<string, unknown>, opts?: { kid?: string; alg?: string; key?: KeyObject }): string
  fetchImpl: JwksFetch
  calls: string[]
  cache: JwksCache
  rotate(): void
  down(): void
}

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')

export function ssoKit(): SsoKit {
  let pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  let available = true
  let counter = 0
  const calls: string[] = []
  const fetchImpl: JwksFetch = async (url) => {
    calls.push(url)
    if (!available) return new Response('down', { status: 503 })
    return Response.json({
      keys: [
        {
          ...(pair.publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
          kid: 'k1',
          alg: 'RS256',
          use: 'sig'
        }
      ]
    })
  }
  return {
    calls,
    fetchImpl,
    cache: createJwksCache({ ttlMs: 60 * 60 * 1000 }),
    rotate() {
      pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
    },
    down() {
      available = false
    },
    mint(overrides = {}, opts = {}) {
      counter += 1
      const claims = {
        iss: entraIssuer(TENANT),
        aud: CLIENT,
        tid: TENANT,
        oid: OID,
        preferred_username: 'sam.lee@example.test',
        uti: `uti-${NOW}-${counter}`,
        iat: NOW / 1000 - 30,
        nbf: NOW / 1000 - 30,
        exp: NOW / 1000 + 3000,
        ...overrides
      }
      const head = b64({ alg: opts.alg ?? 'RS256', typ: 'JWT', kid: opts.kid ?? 'k1' })
      const body = b64(claims)
      const signer = createSign('RSA-SHA256')
      signer.update(`${head}.${body}`)
      return `${head}.${body}.${signer.sign(opts.key ?? pair.privateKey).toString('base64url')}`
    }
  }
}

export interface SignedEnrollOptions {
  /** HMAC key: the credential the request presents. */
  key: string
  body?: Record<string, unknown> | string
  device?: string
  nonce?: string
  ts?: number
  headers?: Record<string, string>
  method?: string
  contentType?: string | null
  /** Signs a different body than the one sent (tamper test). */
  signedBody?: string
}

let nonceSeq = 0

export async function enrollRequest(o: SignedEnrollOptions): Promise<Request> {
  const device = o.device ?? DEVICE
  nonceSeq += 1
  const nonce = o.nonce ?? `nonce-${nonceSeq}-${Math.random().toString(36).slice(2)}`
  const ts = String(o.ts ?? NOW)
  const bodyText = typeof o.body === 'string' ? o.body : JSON.stringify(o.body ?? {})
  const signed = o.signedBody ?? bodyText
  const sig = await hmacHex(o.key || 'empty-credential', ingestCanonical(ts, nonce, device, await sha256Hex(signed)))
  const headers: Record<string, string> = {
    [OPERATOR_HMAC_HEADERS.device]: device,
    [OPERATOR_HMAC_HEADERS.ts]: ts,
    [OPERATOR_HMAC_HEADERS.nonce]: nonce,
    [OPERATOR_HMAC_HEADERS.sig]: sig,
    ...(o.headers ?? {})
  }
  if (o.contentType !== null) headers['content-type'] = o.contentType ?? 'application/json'
  const method = o.method ?? 'POST'
  return new Request('https://operator.test/v1/enroll', {
    method,
    headers,
    ...(method === 'GET' ? {} : { body: bodyText })
  })
}

export function call(
  store: OperatorStore,
  request: Request,
  env: Env = baseEnv(),
  extra: Record<string, unknown> = {},
  now = NOW
): Promise<Response> {
  return handleRequest(request, env, {}, { store, now, ...extra })
}

export async function mintToken(
  store: OperatorStore,
  input: { channel?: string; maxDevices?: number; dailyCap?: number; label?: string; expiresInDays?: number } = {},
  now = NOW
): Promise<{ token: string; kid: string }> {
  const created = await createEnrollToken(
    store,
    { label: input.label ?? 'ci release', channel: input.channel ?? 'release', ...input },
    'owner@example.test',
    now
  )
  if (!created.ok) throw new Error(created.error)
  return { token: created.token, kid: created.row.kid }
}

export const licenseHeader = (token: string): Record<string, string> => ({ [OPERATOR_LICENSE_HEADER]: token })

/** A device heartbeat signed with a per-device licence, the same way the desktop does it. */
export async function heartbeat(
  store: OperatorStore,
  license: string,
  device = DEVICE,
  env: Env = baseEnv(),
  now = NOW
): Promise<Response> {
  const bodyText = JSON.stringify({ os: 'darwin', appVersion: '2.12.0', ssoEmail: 'claimed@example.test' })
  nonceSeq += 1
  const nonce = `hb-${nonceSeq}-${Math.random().toString(36).slice(2)}`
  const sig = await hmacHex(license, ingestCanonical(String(now), nonce, device, await sha256Hex(bodyText)))
  return handleRequest(
    new Request('https://operator.test/v1/heartbeat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [OPERATOR_LICENSE_HEADER]: license,
        [OPERATOR_HMAC_HEADERS.device]: device,
        [OPERATOR_HMAC_HEADERS.ts]: String(now),
        [OPERATOR_HMAC_HEADERS.nonce]: nonce,
        [OPERATOR_HMAC_HEADERS.sig]: sig
      },
      body: bodyText
    }),
    env,
    {},
    { store, now }
  )
}

export function ownerAccess(email = TEST_OWNER_EMAIL): { getIdentity: () => Promise<{ email: string }> } {
  return { getIdentity: async () => ({ email }) }
}
