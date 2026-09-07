#!/usr/bin/env node
/**
 * dev-session.mjs — mints a Métis Operator console session cookie value for a LOCAL
 * `wrangler dev --local` run, so Playwright (or a plain curl) can load the console without going
 * through Cloudflare Access at all.
 *
 * This replicates, statement for statement, the algorithm in operator/src/access.ts:
 *   - `deriveSessionSecret`: OPERATOR_SESSION_SECRET wins if set; otherwise HKDF-SHA256 (empty
 *     salt, info "metis-operator-session", 256 output bits) of OPERATOR_PROMPT_KEY, base64
 *     first, falling back to raw UTF-8 bytes if it does not decode as base64.
 *   - `mintSessionToken`: token = `v1|{iat}|{email}`, signed as
 *     `hmacHex(secret, "metis-operator-session:" + token)` where `hmacHex` HMAC-SHA256s using the
 *     UTF-8 bytes of the (already-hex) derived secret STRING as the key — not the secret's raw
 *     bytes. That double-encoding is exactly what access.ts does, so it is reproduced here rather
 *     than "fixed".
 *   - `sessionCookieHeader` cookie name: `metis_operator_session`.
 *
 * Every step above runs on Node's Web Crypto (`crypto.subtle`, `atob`), the same API surface the
 * Worker uses — no reimplementation on a different primitive.
 *
 * Usage:
 *   OPERATOR_PROMPT_KEY=<base64> node operator/scripts/dev-session.mjs
 *   node operator/scripts/dev-session.mjs --prompt-key <base64> --email tony.walteur@gmail.com
 *   node operator/scripts/dev-session.mjs --session-secret <hex-or-anything>
 *
 * Secret resolution order (highest wins): --session-secret flag, --prompt-key flag,
 * OPERATOR_SESSION_SECRET env var, OPERATOR_PROMPT_KEY env var, then operator/.dev.vars (simple
 * KEY=VALUE lines, the file `wrangler dev --local` itself reads for local secrets).
 *
 * Never logs the secret value itself — only which source supplied it, and the resulting cookie
 * line (which carries a derived signature, not the secret).
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OPERATOR_ROOT = join(__dirname, '..')
const DEV_VARS_PATH = join(OPERATOR_ROOT, '.dev.vars')

export const SESSION_COOKIE = 'metis_operator_session'
const SESSION_HKDF_INFO = 'metis-operator-session'
const DEFAULT_EMAIL = 'tony.walteur@gmail.com'

/** Same fallback as access.ts's base64ToBytes: try base64, else treat as raw UTF-8 text. */
export function base64OrUtf8Bytes(raw) {
  try {
    const bin = atob(raw)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return new TextEncoder().encode(raw)
  }
}

/** Mirrors access.ts `deriveSessionSecret`. `explicit` is OPERATOR_SESSION_SECRET; `promptKey` is
 *  OPERATOR_PROMPT_KEY. Returns the hex-encoded derived secret STRING (not raw bytes) — the same
 *  shape access.ts passes into hmacHex. */
export async function deriveSessionSecretNode({ explicit, promptKey }) {
  const trimmedExplicit = explicit?.trim()
  if (trimmedExplicit) return trimmedExplicit
  const raw = promptKey?.trim()
  if (!raw) return undefined
  const keyMaterial = base64OrUtf8Bytes(raw)
  const key = await crypto.subtle.importKey('raw', keyMaterial, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(SESSION_HKDF_INFO) },
    key,
    256
  )
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Mirrors operator/src/hmac.ts `hmacHex`: HMAC-SHA256 keyed by the UTF-8 bytes of `secret`. */
async function hmacHex(secret, message) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign'
  ])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)))
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Mirrors access.ts `mintSessionToken`. */
export async function mintSessionTokenNode(email, iat, secret) {
  const payload = `v1|${iat}|${email.trim().toLowerCase()}`
  const sig = await hmacHex(secret, `metis-operator-session:${payload}`)
  return `${payload}|${sig}`
}

export function cookieHeaderLine(token) {
  return `Cookie: ${SESSION_COOKIE}=${encodeURIComponent(token)}`
}

/** Simple `.dev.vars` parser: KEY=VALUE lines, `#` comments, blank lines ignored. No quoting
 *  support beyond a single optional pair of surrounding quotes, matching wrangler's own format. */
export function parseDevVars(text) {
  const out = {}
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

function loadDevVarsFile() {
  if (!existsSync(DEV_VARS_PATH)) return {}
  try {
    return parseDevVars(readFileSync(DEV_VARS_PATH, 'utf8'))
  } catch {
    return {}
  }
}

export function parseArgs(argv) {
  const args = { email: DEFAULT_EMAIL, promptKey: null, sessionSecret: null, iat: Date.now() }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--email') args.email = argv[++i]
    else if (a === '--prompt-key') args.promptKey = argv[++i]
    else if (a === '--session-secret') args.sessionSecret = argv[++i]
    else if (a === '--iat') args.iat = Number(argv[++i])
    else if (a === '--help' || a === '-h') args.help = true
  }
  return args
}

function printHelp() {
  console.log(`Usage: node operator/scripts/dev-session.mjs [--email <addr>] [--prompt-key <b64>]
                                          [--session-secret <value>] [--iat <epoch-ms>]

Mints a Métis Operator console session cookie for a local \`wrangler dev --local\` run, using the
same algorithm as operator/src/access.ts. Prints a "Cookie:" header line only — never the secret.

Secret resolution order: --session-secret, --prompt-key, $OPERATOR_SESSION_SECRET,
$OPERATOR_PROMPT_KEY, operator/.dev.vars.`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    process.exit(0)
  }
  const devVars = loadDevVarsFile()
  const explicit = args.sessionSecret || process.env.OPERATOR_SESSION_SECRET || devVars.OPERATOR_SESSION_SECRET
  const promptKey = args.promptKey || process.env.OPERATOR_PROMPT_KEY || devVars.OPERATOR_PROMPT_KEY
  const source = args.sessionSecret
    ? '--session-secret flag'
    : process.env.OPERATOR_SESSION_SECRET
      ? '$OPERATOR_SESSION_SECRET'
      : devVars.OPERATOR_SESSION_SECRET
        ? 'operator/.dev.vars (OPERATOR_SESSION_SECRET)'
        : args.promptKey
          ? '--prompt-key flag'
          : process.env.OPERATOR_PROMPT_KEY
            ? '$OPERATOR_PROMPT_KEY'
            : devVars.OPERATOR_PROMPT_KEY
              ? 'operator/.dev.vars (OPERATOR_PROMPT_KEY)'
              : null

  if (!source) {
    console.error(
      'dev-session.mjs: no secret found. Pass --session-secret, --prompt-key, set ' +
        'OPERATOR_SESSION_SECRET / OPERATOR_PROMPT_KEY, or add one to operator/.dev.vars — this must ' +
        'match whatever `wrangler dev --local` is running with, or the Worker will reject the cookie.'
    )
    process.exit(1)
  }

  const secret = await deriveSessionSecretNode({ explicit, promptKey })
  const token = await mintSessionTokenNode(args.email, args.iat, secret)

  console.log('Métis Operator dev session')
  console.log(`  email:  ${args.email}`)
  console.log(`  iat:    ${args.iat} (${new Date(args.iat).toISOString()})`)
  console.log(`  secret: derived from ${source} (value not printed)`)
  console.log('')
  console.log(cookieHeaderLine(token))
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
