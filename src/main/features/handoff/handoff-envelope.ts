/**
 * Scoped handoff envelope (Métis 2.12 G37, CAP-23). Pure apart from SHA-256.
 *
 * Another app or Métis surface hands the owner one bounded, versioned request. Nothing here executes anything:
 * `parseHandoffEnvelope` only decides whether the envelope is well formed, fresh, from an allowlisted origin and
 * unaltered, and turns its payload into the one desktop request the owner will be asked to confirm.
 *
 * EVERY HANDOFF IS UNAUTHENTICATED: the origin field is a claim, and the allowlist only filters accidents. Any page
 * that can open `metis://` can mint a valid envelope, because the digest is not keyed. Safety comes from the owner's
 * confirmation, a rate limit, never replacing a pending card, and a card that says it came from outside Métis.
 *
 * The digest is an integrity check over every field (SHA-256 over a canonical encoding), not authentication: anyone
 * can compute it, so it proves the fields were not changed in transit and nothing more. Trust comes from the origin
 * allowlist, the single-use nonce, the short window and, above all, the owner's confirmation. No key or secret is
 * shipped in code. A keyed MAC would need a main-owned key shared with each sender; that exchange does not exist yet.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { DesktopActionRequest } from '@shared/desktop-actions'
import { validateDesktopRequest } from '@shared/voice/catalog'

export const HANDOFF_VERSION = 1
export const HANDOFF_MAX_BYTES = 2 * 1024 * 1024
export const HANDOFF_MAX_LIFETIME_MS = 15 * 60_000
/** Clock skew tolerated for an envelope issued slightly in the future. */
export const HANDOFF_CLOCK_SKEW_MS = 60_000
/** ASSUMED allowlist: the Métis surfaces that may hand work over. A payload never names its own trust. */
export const HANDOFF_ORIGINS = ['metis-intelligence', 'metis-agent', 'metis-web'] as const
export type HandoffOrigin = (typeof HANDOFF_ORIGINS)[number]

/** Why an envelope was refused. A closed set: audit records carry one of these and never payload text. */
export const HANDOFF_REJECT_REASONS = [
  'oversize',
  'malformed',
  'unsupported_version',
  'unknown_origin',
  'expired',
  'not_yet_valid',
  'bad_window',
  'digest_mismatch',
  'bad_payload',
  'replayed',
  'ledger_full',
  'storage_unavailable',
  'not_a_handoff_url',
  'not_shown',
  'busy',
  'rate_limited'
] as const
export type HandoffRejectReason = (typeof HANDOFF_REJECT_REASONS)[number]

const NOTE_DATA = z.object({ title: z.string(), body: z.string().optional() }).strict()
export type HandoffPayload = { kind: 'note'; data: z.infer<typeof NOTE_DATA> }

export interface HandoffEnvelope {
  version: typeof HANDOFF_VERSION
  origin: HandoffOrigin
  nonce: string
  issuedAt: number
  expiresAt: number
  payload: HandoffPayload
  digest: string
}

const ENVELOPE = z
  .object({
    version: z.literal(HANDOFF_VERSION),
    origin: z.string().min(1).max(64),
    nonce: z.string().regex(/^[a-f0-9]{64}$/),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    payload: z.object({ kind: z.string().min(1).max(32), data: z.unknown() }).strict(),
    digest: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

type Unsigned = Omit<HandoffEnvelope, 'digest'>

/** Key-order independent encoding of every field the digest binds. */
export function canonicalEncoding(envelope: Unsigned): string {
  return canonicalJson([
    'metis-handoff',
    envelope.version,
    envelope.origin,
    envelope.nonce,
    envelope.issuedAt,
    envelope.expiresAt,
    envelope.payload.kind,
    envelope.payload.data
  ])
}

export function envelopeDigest(envelope: Unsigned): string {
  return createHash('sha256').update(canonicalEncoding(envelope), 'utf8').digest('hex')
}

export type ParsedHandoff =
  | { ok: true; envelope: HandoffEnvelope; request: DesktopActionRequest }
  | { ok: false; reason: HandoffRejectReason }

const reject = (reason: HandoffRejectReason): ParsedHandoff => ({ ok: false, reason })

/** Size is checked on the bytes before anything is parsed. */
export function parseHandoffEnvelope(text: string, now: number): ParsedHandoff {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > HANDOFF_MAX_BYTES) return reject('oversize')
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return reject('malformed')
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return reject('malformed')
  const version = (raw as { version?: unknown }).version
  if (version !== HANDOFF_VERSION) return reject(typeof version === 'number' ? 'unsupported_version' : 'malformed')
  const shaped = ENVELOPE.safeParse(raw)
  if (!shaped.success) return reject('malformed')
  const e = shaped.data
  if (!(HANDOFF_ORIGINS as readonly string[]).includes(e.origin)) return reject('unknown_origin')
  if (e.expiresAt <= e.issuedAt || e.expiresAt - e.issuedAt > HANDOFF_MAX_LIFETIME_MS) return reject('bad_window')
  if (e.expiresAt <= now) return reject('expired')
  if (e.issuedAt > now + HANDOFF_CLOCK_SKEW_MS) return reject('not_yet_valid')
  const unsigned = { ...e, origin: e.origin as HandoffOrigin, payload: e.payload as HandoffPayload }
  const expected = Buffer.from(envelopeDigest({ ...unsigned, version: HANDOFF_VERSION }), 'hex')
  const given = Buffer.from(e.digest, 'hex')
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return reject('digest_mismatch')
  // The payload kind picks the one request main builds; the payload never names an action or a path.
  if (e.payload.kind !== 'note') return reject('bad_payload')
  const note = NOTE_DATA.safeParse(e.payload.data)
  if (!note.success) return reject('bad_payload')
  const request = validateDesktopRequest({
    id: 'desktop.create_note',
    args: { title: note.data.title, ...(note.data.body !== undefined ? { body: note.data.body } : {}) }
  })
  if (!request) return reject('bad_payload')
  return {
    ok: true,
    envelope: { ...unsigned, version: HANDOFF_VERSION, digest: e.digest, payload: { kind: 'note', data: note.data } },
    request
  }
}
