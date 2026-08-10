/**
 * Local-first secret redaction (product brief section I). Strips HIGH-CONFIDENCE secrets from text before
 * it leaves the device for a cloud model — credit-card numbers (Luhn-validated), SSNs, private-key blocks,
 * and recognised API-key/token formats. Deliberately conservative: it does NOT touch phone numbers, emails,
 * or ordinary digits, because those are routinely discussed in meetings and redacting them would gut the
 * copilot's usefulness. The bias is "only redact what is almost certainly a secret."
 *
 * Applied to the AUTO-CAPTURED transcript on the cloud-send path only — never the user's own typed question
 * (that's deliberate) and never the locally-saved meeting file (that keeps the verbatim original).
 *
 * Pure + provider-agnostic so it lives in shared/ and is fully unit-tested.
 */

/** Luhn check — the checksum every real credit-card number satisfies. Filters out random digit runs. */
function luhnValid(digits: string): boolean {
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48
    if (n < 0 || n > 9) return false
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

export function redactSecrets(input: string): string {
  if (!input) return input
  let text = input

  // 1. PEM private-key blocks (multi-line) — redact the whole block.
  text = text.replace(
    /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
    '[redacted private key]'
  )

  // 2. Recognised API-key / token formats (provider-specific prefixes are near-zero false-positive).
  const keyPatterns: RegExp[] = [
    /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, // Anthropic
    // '-' has to stay in this class. Without it the run stops at the prefix's own dash and never reaches
    // 20 chars, so every dashed-prefix key walks straight through — including the sk-kimi- key this app
    // ships itself (see cahe-embedded-key.ts) and OpenAI's current sk-proj- project keys.
    /\bsk-[A-Za-z0-9_-]{20,}\b/g, // OpenAI + generic sk- keys, flat or dash-prefixed
    /\bgh[posru]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens (ghp_/gho_/ghs_/ghr_/ghu_)
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // GitHub fine-grained PAT
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
    /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
    /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
    /\bBearer\s+[A-Za-z0-9._-]{20,}\b/g, // Authorization: Bearer <token>
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g // bare JWT (header.payload.sig — eyJ prefix is base64url of '{"')
  ]
  for (const re of keyPatterns) text = text.replace(re, '[redacted key]')

  // 3. Generic "secret: <value>" assignments — only when a secret-ish label precedes the value, so we don't
  // nuke ordinary numbers/words. Keeps the label, redacts the value.
  text = text.replace(
    /\b(api[_-]?key|secret|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret)["']?(\s*[:=]\s*)(["']?)([^\s"']{6,})\3/gi,
    (_m, label, sep) => `${label}${sep}[redacted]`
  )

  // 4. US SSN (xxx-xx-xxxx) — distinct from phone numbers (xxx-xxx-xxxx), so no phone collisions.
  text = text.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[redacted SSN]')

  // 5. Credit-card numbers: 13-19 digit runs (optionally grouped by spaces/dashes) that pass Luhn. The
  // separator sits only BETWEEN digits (\d then 12-18 × [sep]\d) so a trailing space is never swallowed.
  text = text.replace(/\b\d(?:[ -]?\d){12,18}\b/g, (m) => {
    const digits = m.replace(/[ -]/g, '')
    if (digits.length < 13 || digits.length > 19) return m
    return luhnValid(digits) ? '[redacted card]' : m
  })

  return text
}
