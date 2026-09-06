#!/usr/bin/env node
/**
 * rewrap.mjs - KEK rotation runbook (plan D10): re-encrypts every `vault_keys` and `integrations`
 * ciphertext row from `OPERATOR_VAULT_KEY_OLD` to `OPERATOR_VAULT_KEY`, in place, through
 * `wrangler d1 execute` batches.
 *
 * Mirrors `operator/src/crypto.ts`'s `encryptVault`/`decryptVault` statement for statement (AES-256-GCM
 * via Node's Web Crypto, the same `crypto.subtle` API the Worker uses, same base64 cipher/iv encoding),
 * so a row rewrapped here decrypts identically in the Worker afterward. Never inspects the plaintext
 * beyond decrypt-then-re-encrypt: `vault_keys`/`integrations` ciphertext encodes a secret plus an
 * optional account id (`vault.ts` `encodeVaultPlaintext`), and this script never needs to know that
 * shape to rotate the key wrapping it.
 *
 * Idempotent: a row that already decrypts with `OPERATOR_VAULT_KEY` (an earlier run already rewrapped
 * it, or the row was written after the rotation) is left untouched and counted separately from rows
 * actually rewrapped. A row that decrypts with NEITHER key is left untouched, counted as failed, and
 * named by id only (never a key, never a plaintext value, in any mode).
 *
 * Usage:
 *   OPERATOR_VAULT_KEY_OLD=<b64> OPERATOR_VAULT_KEY=<b64> node operator/scripts/rewrap.mjs --remote
 *   ... node operator/scripts/rewrap.mjs --remote --dry-run     # counts only, writes nothing
 *   ... node operator/scripts/rewrap.mjs --remote --env staging
 *
 * `--dry-run` never touches D1 with a write and never writes the `vault-rewrap` audit row (there is
 * nothing to audit yet). A real run writes exactly one `vault-rewrap` audit row with the counts for
 * both tables once every batch has applied.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDatabaseName } from './migrate.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OPERATOR_ROOT = join(__dirname, '..')
const BATCH_SIZE = 50
const REWRAP_TABLES = ['vault_keys', 'integrations']

// ---------------------------------------------------------------------------
// Crypto: byte-for-byte the same as operator/src/crypto.ts's encryptVault/decryptVault.
// ---------------------------------------------------------------------------

export function bytesToB64(bytes) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

export function b64ToBytes(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Throws the same way crypto.ts's decodeAesKey does: a key must be exactly 32 bytes, base64. */
export function decodeVaultKey(raw, name) {
  const trimmed = (raw || '').trim()
  try {
    const bytes = b64ToBytes(trimmed)
    if (bytes.length === 32) return bytes
  } catch {
    /* fall through */
  }
  throw new Error(`${name} must be 32 bytes, base64`)
}

async function encryptAesGcm(plaintext, keyBytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt'])
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)))
  return { cipher: bytesToB64(cipher), iv: bytesToB64(iv) }
}

async function decryptAesGcm(cipher, iv, keyBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt'])
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(iv) }, key, b64ToBytes(cipher))
  return new TextDecoder().decode(plain)
}

/**
 * Idempotent, key-swap-only re-encryption of one `{cipher, iv}` row.
 *   'already-new'    - decrypts with the NEW key already; nothing to do.
 *   'rewrapped'      - decrypted with the OLD key, re-encrypted with the NEW key.
 *   'undecryptable'  - decrypts with neither key (corrupt row, or a key mismatch); left untouched.
 */
export async function rewrapCiphertext(row, oldKeyBytes, newKeyBytes) {
  try {
    await decryptAesGcm(row.cipher, row.iv, newKeyBytes)
    return { status: 'already-new' }
  } catch {
    /* not decryptable with the new key yet - try the old one */
  }
  let plaintext
  try {
    plaintext = await decryptAesGcm(row.cipher, row.iv, oldKeyBytes)
  } catch {
    return { status: 'undecryptable' }
  }
  const enc = await encryptAesGcm(plaintext, newKeyBytes)
  return { status: 'rewrapped', cipher: enc.cipher, iv: enc.iv }
}

// ---------------------------------------------------------------------------
// Pure helpers: args, SQL building, batching. Unit-tested without touching wrangler.
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = { target: null, dryRun: false, env: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--remote') args.target = 'remote'
    else if (a === '--local') args.target = 'local'
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--env') args.env = argv[++i]
    else if (a === '--help' || a === '-h') args.help = true
  }
  return args
}

/** Single-quote SQL string escaping for the inline `--command`/batch-file statements this script
 *  sends through `wrangler d1 execute` (the same approach `migrate.mjs`'s `seedDefaultTiers` uses -
 *  no parameterised `wrangler d1 execute`, so values are escaped, not bound). */
export function sqlString(v) {
  return String(v).replace(/'/g, "''")
}

export function buildSelectSql(table) {
  return `SELECT id, cipher, iv FROM ${table} WHERE cipher IS NOT NULL AND cipher != ''`
}

export function buildUpdateStatement(table, id, cipher, iv) {
  return `UPDATE ${table} SET cipher = '${sqlString(cipher)}', iv = '${sqlString(iv)}' WHERE id = '${sqlString(id)}';`
}

export function buildAuditInsertStatement(id, now, detail) {
  return `INSERT INTO audit (id, ts, actor, action, ask_id, detail, request_id, route) VALUES ('${sqlString(id)}', ${now}, 'system', 'vault-rewrap', NULL, '${sqlString(detail)}', NULL, NULL);`
}

export function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export function formatAuditDetail(counts) {
  return REWRAP_TABLES.map((t) => `${t} ${counts[t].rewrapped} rewrapped/${counts[t].alreadyOk} ok/${counts[t].failed} failed`).join('; ')
}

export function resolveDbNameFromWrangler(wranglerJsoncText, envName) {
  const { databaseName } = resolveDatabaseName(wranglerJsoncText, envName)
  return databaseName
}

// ---------------------------------------------------------------------------
// wrangler I/O. `exec` is dependency-injected (default: real execFileSync) so the contract test
// can verify argument construction and batching without a network call or a Cloudflare login.
// ---------------------------------------------------------------------------

function defaultExec(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function wranglerArgsFor(databaseName, target, envName, extra) {
  const args = ['wrangler', 'd1', 'execute', databaseName, target === 'remote' ? '--remote' : '--local', ...extra]
  if (envName) args.push('--env', envName)
  return args
}

function selectRows(table, { databaseName, target, envName, exec }) {
  const args = wranglerArgsFor(databaseName, target, envName, ['--command', buildSelectSql(table), '--json'])
  const out = exec('npx', args)
  const parsed = JSON.parse(out)
  // `wrangler d1 execute --json` prints one object per statement, each with a `results` array.
  const first = Array.isArray(parsed) ? parsed[0] : parsed
  return first?.results ?? []
}

function runBatch(statements, { databaseName, target, envName, exec }) {
  if (!statements.length) return
  const dir = mkdtempSync(join(tmpdir(), 'metis-rewrap-'))
  const file = join(dir, 'batch.sql')
  try {
    writeFileSync(file, statements.join('\n'))
    const args = wranglerArgsFor(databaseName, target, envName, [`--file=${file}`])
    exec('npx', args)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** One table's full rewrap pass: select every ciphertext row, decide per row (idempotent, batched
 *  writes). Returns the counts; `--dry-run` never calls `runBatch`. */
export async function rewrapTable(table, { oldKeyBytes, newKeyBytes, dryRun, databaseName, target, envName, exec, log }) {
  const rows = selectRows(table, { databaseName, target, envName, exec })
  const counts = { total: rows.length, rewrapped: 0, alreadyOk: 0, failed: 0 }
  const statements = []
  for (const row of rows) {
    const result = await rewrapCiphertext(row, oldKeyBytes, newKeyBytes)
    if (result.status === 'already-new') counts.alreadyOk++
    else if (result.status === 'undecryptable') {
      counts.failed++
      log?.(`rewrap.mjs: ${table} row ${row.id} did not decrypt with either key - left untouched`)
    } else {
      counts.rewrapped++
      if (!dryRun) statements.push(buildUpdateStatement(table, row.id, result.cipher, result.iv))
    }
  }
  if (!dryRun) {
    for (const batch of chunk(statements, BATCH_SIZE)) runBatch(batch, { databaseName, target, envName, exec })
  }
  return counts
}

function printCounts(table, counts, dryRun) {
  const verb = dryRun ? 'would rewrap' : 'rewrapped'
  console.log(`${table}: ${counts.total} row(s) with ciphertext - ${counts.rewrapped} ${verb}, ${counts.alreadyOk} already on the new key, ${counts.failed} undecryptable`)
}

export async function runRewrap({ args, env = process.env, exec = defaultExec, log = console.error } = {}) {
  const oldKeyRaw = env.OPERATOR_VAULT_KEY_OLD
  const newKeyRaw = env.OPERATOR_VAULT_KEY
  if (!oldKeyRaw || !newKeyRaw) {
    throw new Error('rewrap.mjs: both OPERATOR_VAULT_KEY_OLD and OPERATOR_VAULT_KEY must be set')
  }
  const oldKeyBytes = decodeVaultKey(oldKeyRaw, 'OPERATOR_VAULT_KEY_OLD')
  const newKeyBytes = decodeVaultKey(newKeyRaw, 'OPERATOR_VAULT_KEY')
  if (!args.target) throw new Error('Usage: node operator/scripts/rewrap.mjs --remote|--local [--dry-run] [--env <name>]')

  const wranglerJsoncText = readWranglerJsonc()
  const databaseName = resolveDbNameFromWrangler(wranglerJsoncText, args.env)

  const counts = {}
  for (const table of REWRAP_TABLES) {
    counts[table] = await rewrapTable(table, {
      oldKeyBytes,
      newKeyBytes,
      dryRun: args.dryRun,
      databaseName,
      target: args.target,
      envName: args.env,
      exec,
      log
    })
    printCounts(table, counts[table], args.dryRun)
  }

  if (!args.dryRun) {
    const detail = formatAuditDetail(counts)
    runBatch([buildAuditInsertStatement(crypto.randomUUID(), Date.now(), detail)], {
      databaseName,
      target: args.target,
      envName: args.env,
      exec
    })
    console.log(`Audited: vault-rewrap - ${detail}`)
  } else {
    console.log('Dry run: no ciphertext was written and no audit row was created. Re-run without --dry-run to apply.')
  }
  return counts
}

function readWranglerJsonc() {
  return readFileSync(join(OPERATOR_ROOT, 'wrangler.jsonc'), 'utf8')
}

function printHelp() {
  console.log(`Usage: node operator/scripts/rewrap.mjs --remote|--local [--dry-run] [--env <name>]

Re-encrypts every vault_keys and integrations ciphertext row from OPERATOR_VAULT_KEY_OLD to
OPERATOR_VAULT_KEY, in place. Idempotent: a row already on the new key is skipped. --dry-run prints
counts only and writes nothing. Never prints a key or a plaintext value.

Required environment: OPERATOR_VAULT_KEY_OLD, OPERATOR_VAULT_KEY (both base64, 32 bytes).`)
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    process.exit(0)
  }
  runRewrap({ args }).catch((err) => {
    console.error(`rewrap.mjs: ${err.message}`)
    process.exit(1)
  })
}
