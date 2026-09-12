#!/usr/bin/env node
/**
 * Applies operator/schema.sql then operator/schema-alter.sql to metis-operator D1, one statement at
 * a time, via the lockfile-pinned local Wrangler CLI. Every CREATE TABLE/INDEX in both files is IF NOT EXISTS
 * (see migrate.contract.test.ts), so a statement that already applied is a no-op, not a failure; the
 * handful of bare ALTER TABLE ADD COLUMN statements in schema-alter.sql are not idempotent in SQLite
 * itself, so this runner treats "duplicate column name" (and "already exists", belt and suspenders)
 * as skipped rather than failing the whole migration.
 *
 * Usage:
 *   node operator/scripts/migrate.mjs --remote                    Apply to the production D1.
 *   node operator/scripts/migrate.mjs --local                     Apply to the local wrangler dev D1.
 *   node operator/scripts/migrate.mjs --remote --env staging      Apply to the staging D1 (section 9d).
 *   node operator/scripts/migrate.mjs --dry-run                   Print statements, run nothing.
 *
 * `--env <name>` resolves the database name from `wrangler.jsonc`'s `env.<name>.d1_databases[0]`
 * (falling back to the top-level `d1_databases[0]` with no `--env`) and appends `--env <name>` to
 * every `wrangler d1 execute` call, so the statements land on that environment's own D1, not
 * production's. A database whose id is still the placeholder from `wrangler.jsonc` (the environment's
 * D1 was never created) refuses to run rather than silently doing nothing against a database that
 * doesn't exist.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { commandFailureDetails, localNodeCommand } from './toolchain.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OPERATOR_ROOT = join(__dirname, '..')

export const PLACEHOLDER_DATABASE_ID = 'REPLACE_AFTER_D1_CREATE'

/** Strips `//` line comments and `/* *\/` block comments from a JSONC document without touching
 *  either inside a string literal, so `wrangler.jsonc`'s section 9d comment blocks can sit next to
 *  normal JSON and still parse after stripping. */
export function stripJsonComments(text) {
  let out = ''
  let inString = false
  let inLineComment = false
  let inBlockComment = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const next = text[i + 1]
    if (inLineComment) {
      if (c === '\n') {
        inLineComment = false
        out += c
      }
      continue
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false
        i++
      }
      continue
    }
    if (inString) {
      out += c
      if (c === '\\') {
        out += next
        i++
        continue
      }
      if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      continue
    }
    if (c === '/' && next === '/') {
      inLineComment = true
      i++
      continue
    }
    if (c === '/' && next === '*') {
      inBlockComment = true
      i++
      continue
    }
    out += c
  }
  return out
}

/** Pure resolver: given `wrangler.jsonc`'s text and an env name (or `null` for the top level),
 *  returns the D1 binding's `database_name` and `database_id` for that env. Throws when the env (or
 *  its `d1_databases[0]`) doesn't exist, so a typo'd `--env` fails loudly instead of silently
 *  falling back to production. */
export function resolveDatabaseName(wranglerJsoncText, envName) {
  const config = JSON.parse(stripJsonComments(wranglerJsoncText))
  if (!envName) {
    const db = config.d1_databases?.[0]
    if (!db) throw new Error('wrangler.jsonc: no d1_databases at the top level')
    return { databaseName: db.database_name, databaseId: db.database_id }
  }
  const envConfig = config.env?.[envName]
  if (!envConfig) throw new Error(`wrangler.jsonc: no env "${envName}"`)
  const db = envConfig.d1_databases?.[0]
  if (!db) throw new Error(`wrangler.jsonc: env "${envName}" has no d1_databases`)
  return { databaseName: db.database_name, databaseId: db.database_id }
}

export function isPlaceholderDatabaseId(id) {
  return id === PLACEHOLDER_DATABASE_ID
}

/** Strip full-line `--` comments, then split on `;`. Every statement in schema.sql /
 *  schema-alter.sql is a single line or a single CREATE ... (...) block with no `;` inside it,
 *  so a naive split is exact here (no string literals in these files contain a semicolon). */
export function parseStatements(sql) {
  const withoutComments = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
  return withoutComments
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
}

const AUTH_OR_TRUST_FAILURE = /authentication|unauthori[sz]ed|forbidden|permission denied|access denied|invalid.*(?:token|credential)|\b(?:HTTP|status["']?)[\s:=]+40[13]\b|certificate|self[-_ ]signed|\b(?:CERT_|TLS_|ERR_TLS_|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/i
const SQL_FAILURE = /SQLITE_|\bD1_(?:ERROR|EXEC_ERROR)\b|syntax error|no such (?:table|column)|constraint failed/i

function isSkippableError(stmt, message) {
  if (!isRetrySafeStatement(stmt) || AUTH_OR_TRUST_FAILURE.test(message)) return false
  if (/syntax error|no such (?:table|column)|constraint failed/i.test(message)) return false
  return /^ALTER\s+TABLE\b/i.test(stmt.trim()) && /duplicate column name/i.test(message)
    || /^CREATE\b/i.test(stmt.trim()) && /already exists/i.test(message)
}

/** The migration files contain one statement per call. Only additive/idempotent forms may be
 * replayed after an uncertain transport result. Tier seeds are safe because tiers.id is a PK. */
export function isRetrySafeStatement(stmt) {
  const sql = stmt.trim()
  if (sql.includes(';')) return false
  return /^CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\b/i.test(sql)
    || /^ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN\b/i.test(sql)
    || /^INSERT\s+OR\s+IGNORE\s+INTO\s+tiers\s*\(/i.test(sql)
}

function transientTransportFailure(result) {
  // Spawn errors, signals and unexplained exits must fail closed, not enter the retry path.
  if (result.error || result.signal || result.status == null || result.status === 0) return false
  const message = `${result.stdout || ''}\n${result.stderr || ''}`
  if (AUTH_OR_TRUST_FAILURE.test(message) || SQL_FAILURE.test(message)) return false
  // "fetch failed" alone does not distinguish a transient outage from a permanent trust error.
  return /\b(?:EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_SOCKET)\b|Unable to resolve Cloudflare's API hostname/i.test(message)
}

export async function runStatement(stmt, target, databaseName, envName, options = {}) {
  const args = ['d1', 'execute', databaseName, '--command', stmt, target === 'remote' ? '--remote' : '--local']
  if (envName) args.push('--env', envName)
  const command = localNodeCommand('wrangler', args)
  const execute = options.spawn ?? spawnSync
  const wait = options.sleep ?? sleep
  const onRetry = options.onRetry ?? ((attempt, delayMs) => {
    console.warn(`[retry] transient Cloudflare transport failure; attempt ${attempt}/3 after ${delayMs}ms`)
  })
  for (let attempt = 1; attempt <= 3; attempt++) {
    let result
    try {
      result = execute(command.cmd, command.args, {
        cwd: OPERATOR_ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8'
      })
    } catch (error) {
      result = { status: null, signal: null, error }
    }
    const completed = result.status != null && !result.signal && !result.error
    if (completed && result.status === 0) return { status: 'applied', attempts: attempt }
    const message = commandFailureDetails(result)
    if (completed && isSkippableError(stmt, message)) return { status: 'skipped', message, attempts: attempt }
    if (attempt === 3 || !isRetrySafeStatement(stmt) || !transientTransportFailure(result)) {
      return { status: 'failed', message, attempts: attempt }
    }
    const delayMs = attempt * 1000
    onRetry(attempt + 1, delayMs)
    await wait(delayMs)
  }
}

function summarize(label, results) {
  const applied = results.filter((r) => r.status === 'applied').length
  const skipped = results.filter((r) => r.status === 'skipped').length
  const failed = results.filter((r) => r.status === 'failed')
  console.log(`${label}: ${applied} applied, ${skipped} skipped, ${failed.length} failed (of ${results.length})`)
  return failed
}

function shortStmt(stmt) {
  const s = stmt.replace(/\s+/g, ' ').trim()
  return s.length > 100 ? `${s.slice(0, 97)}...` : s
}

/** Kept in sync by hand with DEFAULT_TIER_ENTITLEMENTS in operator/src/store.ts (section 9c). A plain
 *  JS literal here, not an import: this script runs standalone against wrangler, no TS toolchain. */
const DEFAULT_TIER_ENTITLEMENTS = {
  metis: ['ask', 'listen', 'recap', 'crm_push', 'operator_keys', 'intelligence', 'integrations'],
  'metis-light': ['ask', 'intelligence']
}

export async function seedDefaultTiers(target, databaseName, envName, execute = runStatement) {
  const now = Date.now()
  console.log('--- Seeding default tiers (metis, metis-light) ---')
  for (const [id, entitlements] of Object.entries(DEFAULT_TIER_ENTITLEMENTS)) {
    const label = id === 'metis' ? 'Métis' : 'Métis Light'
    const entitlementsJson = JSON.stringify(entitlements).replace(/'/g, "''")
    const sql = `INSERT OR IGNORE INTO tiers (id, label, entitlements_json, updated_at) VALUES ('${id}', '${label}', '${entitlementsJson}', ${now})`
    const result = await execute(sql, target, databaseName, envName)
    console.log(`[${result.status}] tier ${id}`)
    if (result.status === 'failed') throw new Error(`Default tier ${id} seed failed: ${result.message}`)
  }
}

function envFlagValue(args) {
  const i = args.indexOf('--env')
  if (i < 0) return null
  const value = args[i + 1]
  if (!value || value.startsWith('--')) {
    console.error('Usage: --env <name> requires a value (e.g. --env staging)')
    process.exit(1)
  }
  return value
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const target = args.includes('--remote') ? 'remote' : args.includes('--local') ? 'local' : null
  const envName = envFlagValue(args)
  if (!dryRun && !target) {
    console.error('Usage: node operator/scripts/migrate.mjs --remote | --local | --dry-run [--env <name>]')
    process.exit(1)
  }

  const wranglerJsoncText = readFileSync(join(OPERATOR_ROOT, 'wrangler.jsonc'), 'utf8')
  const { databaseName, databaseId } = resolveDatabaseName(wranglerJsoncText, envName)
  if (isPlaceholderDatabaseId(databaseId)) {
    console.error(
      `Métis Operator migration: env "${envName}" still has the placeholder database id (${PLACEHOLDER_DATABASE_ID}). ` +
        `Run "npx wrangler@4 d1 create ${databaseName}" and paste the printed id into wrangler.jsonc first.`
    )
    process.exit(1)
  }

  const files = ['schema.sql', 'schema-alter.sql']
  let anyFailed = false

  for (const file of files) {
    const sql = readFileSync(join(OPERATOR_ROOT, file), 'utf8')
    const statements = parseStatements(sql)
    if (dryRun) {
      console.log(`--- ${file}: ${statements.length} statement(s) (database: ${databaseName}) ---`)
      for (const stmt of statements) console.log(shortStmt(stmt))
      continue
    }
    console.log(`--- Applying ${file} (${statements.length} statement(s)) to ${target} (database: ${databaseName}${envName ? `, env: ${envName}` : ''}) ---`)
    const results = []
    for (const stmt of statements) {
      const result = await runStatement(stmt, target, databaseName, envName)
      results.push(result)
      console.log(`[${result.status}] ${shortStmt(stmt)}`)
      if (result.status === 'failed') console.error(result.message)
    }
    const failed = summarize(file, results)
    if (failed.length) anyFailed = true
  }

  if (!dryRun && !anyFailed) {
    await seedDefaultTiers(target, databaseName, envName)
  }

  if (anyFailed) {
    console.error('Métis Operator migration: one or more statements failed. See errors above.')
    process.exit(1)
  }
  if (!dryRun) console.log('Métis Operator migration: complete.')
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
