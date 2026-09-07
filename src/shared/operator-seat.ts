/**
 * Desktop -> Worker heartbeat/ingest seat metadata (contract v2, PLAN.md section 3).
 * Pure sanitizers only: every field is validated against a closed shape before it can ship, so a
 * caller passing a raw, unchecked value (env var, disk read, IPC payload) can never leak a secret,
 * an over-long string, or a value outside the Worker's closed vocabulary onto the wire.
 */

export const OPERATOR_LICENSE_STATES = ['licensed', 'trial', 'grace', 'expired', 'unlicensed'] as const
export type OperatorLicenseState = (typeof OPERATOR_LICENSE_STATES)[number]

export interface SeatMeta {
  seatHash: string
  os: string
  appVersion: string
  hostname?: string
  ssoEmail?: string
  license?: OperatorLicenseState
  licenseLast4?: string
  licenseId?: string
  lastIndexAt?: number
}

export interface BuildSeatMetaInput {
  seatHash: string
  os: string
  appVersion: string
  hostname?: string | null
  ssoEmail?: string | null
  /** Raw candidate state string; validated against OPERATOR_LICENSE_STATES. */
  license?: string | null
  licenseLast4?: string | null
  /** Raw candidate jti; validated as 16 lowercase hex chars (operator-license.ts's format). */
  licenseId?: string | null
  lastIndexAt?: number | null
}

const MAX_HOSTNAME_LEN = 64

// Names/prefixes that read as a credential rather than a machine name. A hostname never legitimately
// contains these words, and a stray secret landing in the hostname field (misconfigured env var, a
// copy-paste mistake) must never reach the wire.
const SECRET_WORDS = /(secret|password|passwd|api[_-]?key|apikey|private[_-]?key|bearer|credential|token)/i
const SECRET_PREFIXES = /^(sk-|ghp_|gho_|glpat-|xox[baprs]-|akia|metis-op-1)/i

/** Opaque, high-entropy blobs (tokens, keys) read as one long run of base64/hex-ish characters with no
 *  separators. Real hostnames almost always carry a dot or hyphen well before this length; the few that
 *  don't are rare enough that refusing them is the safer default for a field that ships off-device. */
function looksLikeOpaqueToken(s: string): boolean {
  return !/[\s.]/.test(s) && s.length >= 32 && /^[A-Za-z0-9+/_=-]+$/.test(s) && /[0-9]/.test(s) && /[A-Za-z]/.test(s)
}

function looksLikeSecret(s: string): boolean {
  return SECRET_WORDS.test(s) || SECRET_PREFIXES.test(s) || looksLikeOpaqueToken(s)
}

/** Hostname from os.hostname(): trimmed, capped at 64 chars, never a secret-looking string. */
export function sanitizeSeatHostname(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (looksLikeSecret(trimmed)) return undefined
  return trimmed.slice(0, MAX_HOSTNAME_LEN)
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/

/** Signed-in identity email: lowercased, shape-checked, capped. Never a guess. */
export function sanitizeSeatSsoEmail(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed || trimmed.length > 254) return undefined
  return EMAIL_RE.test(trimmed) ? trimmed : undefined
}

const LICENSE_STATE_SET: ReadonlySet<string> = new Set(OPERATOR_LICENSE_STATES)

/** License state: must be exactly one of the Worker's closed vocabulary, else omitted (never a guess). */
export function sanitizeSeatLicenseState(raw: unknown): OperatorLicenseState | undefined {
  if (typeof raw !== 'string') return undefined
  const v = raw.trim().toLowerCase()
  return LICENSE_STATE_SET.has(v) ? (v as OperatorLicenseState) : undefined
}

/** Last 4 alphanumerics of a license key. Never fewer than 4 (a short fragment is more identifying,
 *  proportionally, than a normal last4 and is refused rather than shipped short). Never the raw key. */
export function sanitizeSeatLicenseLast4(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const alnum = raw.replace(/[^a-zA-Z0-9]/g, '')
  if (alnum.length < 4) return undefined
  return alnum.slice(-4)
}

/** Operator-issued license jti (METIS-OP-1 format): 16 lowercase hex chars only. */
export function sanitizeSeatLicenseId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const v = raw.trim().toLowerCase()
  return /^[a-f0-9]{16}$/.test(v) ? v : undefined
}

/** Last successful intelligence-index run, ms epoch. Finite, positive, never a guess at "now". */
export function sanitizeSeatLastIndexAt(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : undefined
}

/**
 * Build the full v2 seat payload from real, already-resolved sources. Pure: every optional field is
 * independently sanitized and simply omitted (never replaced by a placeholder) when it fails validation
 * or was never supplied. seatHash/os/appVersion are trusted as already-computed by the caller (unchanged
 * from the v1 contract).
 */
export function buildSeatMeta(input: BuildSeatMetaInput): SeatMeta {
  const meta: SeatMeta = {
    seatHash: input.seatHash,
    os: input.os,
    appVersion: input.appVersion
  }
  const hostname = sanitizeSeatHostname(input.hostname)
  if (hostname !== undefined) meta.hostname = hostname
  const ssoEmail = sanitizeSeatSsoEmail(input.ssoEmail)
  if (ssoEmail !== undefined) meta.ssoEmail = ssoEmail
  const license = sanitizeSeatLicenseState(input.license)
  if (license !== undefined) meta.license = license
  const licenseLast4 = sanitizeSeatLicenseLast4(input.licenseLast4)
  if (licenseLast4 !== undefined) meta.licenseLast4 = licenseLast4
  const licenseId = sanitizeSeatLicenseId(input.licenseId)
  if (licenseId !== undefined) meta.licenseId = licenseId
  const lastIndexAt = sanitizeSeatLastIndexAt(input.lastIndexAt)
  if (lastIndexAt !== undefined) meta.lastIndexAt = lastIndexAt
  return meta
}
