/**
 * Runtime reader for the build-embedded Operator enrolment token (interface for O07, filled by O11).
 *
 * The packaged blob is produced at build time (scripts/embed-operator-enroll-token.mjs, O11) and holds
 * `{ token, operatorUrl }`. Like the Cloudflare embed, it is obfuscated, not secret: the token is scoped to
 * enrolment, `reporting` tier only, capped and revocable on the Worker. This module is the single seam the
 * enrolment glue reads. Until a build ships a blob (every dev, QA-without-token and local build) it returns
 * null, and enrolment falls back to the SSO path only, which is the designed missing-token behaviour.
 */
export interface EmbeddedOperatorEnrollToken {
  /** `METIS-ENR-1.<kid>.<secret>` */
  token: string
  /** The Operator URL this token was issued for. The caller uses the token only when it equals the base URL. */
  operatorUrl: string
}

const TOKEN_RE = /^METIS-ENR-1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

type Provider = () => EmbeddedOperatorEnrollToken | null
// O11 installs the decrypting provider here; no provider means no embedded token.
let provider: Provider | null = null

export function setEmbeddedOperatorEnrollProvider(next: Provider | null): void {
  provider = next
}

export function readEmbeddedOperatorEnrollToken(): EmbeddedOperatorEnrollToken | null {
  let value: EmbeddedOperatorEnrollToken | null = null
  try {
    value = provider?.() ?? null
  } catch {
    return null
  }
  if (!value || !TOKEN_RE.test(value.token) || !/^https:\/\//i.test(value.operatorUrl)) return null
  return value
}
