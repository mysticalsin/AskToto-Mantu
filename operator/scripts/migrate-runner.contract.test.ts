import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isRetrySafeStatement, parseStatements, runStatement, seedDefaultTiers } from './migrate.mjs'

const statement = 'ALTER TABLE seats ADD COLUMN country TEXT'
const failed = (stderr = '', extra = {}) => ({ status: 1, signal: null, stdout: '', stderr, ...extra })
const succeeded = { status: 0, signal: null, stdout: 'ok', stderr: '' }
const dns = "Unable to resolve Cloudflare's API hostname (api.cloudflare.com or dash.cloudflare.com)."

afterEach(() => vi.restoreAllMocks())

function fixture(...results) {
  const spawn = vi.fn()
  for (const result of results) spawn.mockReturnValueOnce(result)
  const sleep = vi.fn(async () => {})
  const onRetry = vi.fn()
  return { spawn, sleep, onRetry }
}

describe('MQA-313 fail-closed migration execution', () => {
  it('runs the pinned local Wrangler with explicit cwd and no npx/shell', async () => {
    const f = fixture(succeeded)
    await expect(runStatement(statement, 'remote', 'metis-operator', null, f))
      .resolves.toMatchObject({ status: 'applied', attempts: 1 })
    expect(f.spawn).toHaveBeenCalledWith(process.execPath, [
      resolve(__dirname, '../../node_modules/wrangler/bin/wrangler.js'),
      'd1', 'execute', 'metis-operator', '--command', statement, '--remote'
    ], expect.objectContaining({ cwd: resolve(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
    expect(f.spawn.mock.calls[0][2].shell).toBeUndefined()
    expect(f.sleep).not.toHaveBeenCalled()
  })

  it('preserves local/staging flags without falling back to production', async () => {
    const f = fixture(succeeded)
    await runStatement(statement, 'local', 'metis-operator-staging', 'staging', f)
    expect(f.spawn.mock.calls[0][1]).toEqual([
      resolve(__dirname, '../../node_modules/wrangler/bin/wrangler.js'),
      'd1', 'execute', 'metis-operator-staging', '--command', statement, '--local', '--env', 'staging'
    ])
  })

  it('skips a completed duplicate-column response without retry', async () => {
    const f = fixture(failed('duplicate column name: country [SQLITE_ERROR]'))
    await expect(runStatement(statement, 'remote', 'metis-operator', null, f))
      .resolves.toMatchObject({ status: 'skipped', attempts: 1 })
    expect(f.spawn).toHaveBeenCalledTimes(1)
    expect(f.sleep).not.toHaveBeenCalled()
  })

  it.each([dns, 'fetch failed: EAI_AGAIN', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT'])
    ('retries only an explicit transient transport failure: %s', async (message) => {
      const f = fixture(failed(message), succeeded)
      await expect(runStatement(statement, 'remote', 'metis-operator', null, f))
        .resolves.toMatchObject({ status: 'applied', attempts: 2 })
      expect(f.sleep).toHaveBeenCalledExactlyOnceWith(1000)
      expect(f.onRetry).toHaveBeenCalledTimes(1)
    })

  it('recognizes a duplicate after an uncertain transport result without applying twice', async () => {
    const f = fixture(failed('fetch failed: ECONNRESET'), failed('duplicate column name: country'))
    await expect(runStatement(statement, 'remote', 'metis-operator', null, f))
      .resolves.toMatchObject({ status: 'skipped', attempts: 2 })
  })

  it('stops after exactly three transport attempts with bounded backoff', async () => {
    const f = fixture(failed(dns), failed(dns), failed(dns), succeeded)
    await expect(runStatement(statement, 'remote', 'metis-operator', null, f))
      .resolves.toMatchObject({ status: 'failed', attempts: 3 })
    expect(f.spawn).toHaveBeenCalledTimes(3)
    expect(f.sleep.mock.calls).toEqual([[1000], [2000]])
  })

  it.each([
    ['SQL syntax', failed('SQLITE_ERROR: syntax error; fetch failed')],
    ['missing table', failed('no such table: seats; ECONNRESET')],
    ['authentication', failed('Authentication error [code: 10000]; fetch failed')],
    ['forbidden', failed('HTTP 403 Forbidden; ECONNRESET')],
    ['JSON auth status', failed('{"status":401,"message":"ECONNRESET"}')],
    ['invalid certificate', failed('self-signed certificate; fetch failed')],
    ['TLS identity error', failed('ERR_TLS_CERT_ALTNAME_INVALID; ECONNRESET')],
    ['unclassified fetch failure', failed('fetch failed')],
    ['auth error mentioning an existing object', failed('Authentication error: object already exists')],
    ['unexplained exit', failed()],
    ['signal', failed('ECONNRESET', { status: null, signal: 'SIGKILL' })],
    ['spawn error', failed('EAI_AGAIN', { status: null, error: { code: 'ENOENT' } })]
  ])('never retries a %s failure', async (_name, result) => {
    const f = fixture(result, succeeded)
    const actual = await runStatement(statement, 'remote', 'metis-operator', null, f)
    expect(actual.status).toBe('failed')
    expect(actual.attempts).toBe(1)
    expect(actual.message).toMatch(/exit=.*signal=.*error=/)
    expect(f.spawn).toHaveBeenCalledTimes(1)
    expect(f.sleep).not.toHaveBeenCalled()
  })

  it('never interprets a signalled process as a successful duplicate skip', async () => {
    const f = fixture(failed('duplicate column name: country', { status: null, signal: 'SIGKILL' }))
    expect((await runStatement(statement, 'remote', 'metis-operator', null, f)).status).toBe('failed')
  })

  it('preserves a thrown spawn error without retrying it', async () => {
    const f = fixture()
    f.spawn.mockImplementation(() => { throw Object.assign(new Error('missing executable'), { code: 'ENOENT' }) })
    const result = await runStatement(statement, 'remote', 'metis-operator', null, f)
    expect(result).toMatchObject({ status: 'failed', attempts: 1 })
    expect(result.message).toContain('error=ENOENT')
    expect(f.spawn).toHaveBeenCalledTimes(1)
  })

  it('stops immediately when a transport retry reveals a SQL failure', async () => {
    const f = fixture(failed(dns), failed('SQLITE_ERROR: no such table: seats'), succeeded)
    await expect(runStatement(statement, 'remote', 'metis-operator', null, f))
      .resolves.toMatchObject({ status: 'failed', attempts: 2 })
    expect(f.spawn).toHaveBeenCalledTimes(2)
  })

  it.each(['DELETE FROM seats', 'UPDATE seats SET approval = "approved"',
    'CREATE TABLE seats (id TEXT)', 'CREATE TABLE IF NOT EXISTS x (id TEXT); DROP TABLE seats'])
    ('never retries SQL outside the known idempotent forms: %s', async (sql) => {
      const f = fixture(failed(dns), succeeded)
      expect((await runStatement(sql, 'remote', 'metis-operator', null, f)).status).toBe('failed')
      expect(f.spawn).toHaveBeenCalledTimes(1)
    })

  it('explicitly recognizes every current schema statement as retry-safe', () => {
    for (const file of ['schema.sql', 'schema-alter.sql']) {
      const sql = readFileSync(resolve(__dirname, '..', file), 'utf8')
      for (const stmt of parseStatements(sql)) expect(isRetrySafeStatement(stmt), stmt).toBe(true)
    }
    expect(isRetrySafeStatement("INSERT OR IGNORE INTO tiers (id) VALUES ('metis')")).toBe(true)
    expect(isRetrySafeStatement("INSERT INTO tiers (id) VALUES ('metis')")).toBe(false)
  })

  it('fails the migration gate when a default-tier seed fails', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const execute = vi.fn().mockResolvedValue({ status: 'failed', attempts: 1, message: 'exit=1 signal=none error=none' })
    await expect(seedDefaultTiers('remote', 'metis-operator', null, execute)).rejects.toThrow(/tier metis.*failed/i)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('seeds both default tiers through retry-safe insert-or-ignore statements', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const execute = vi.fn().mockResolvedValue({ status: 'applied', attempts: 1 })
    await seedDefaultTiers('remote', 'metis-operator', null, execute)
    expect(execute).toHaveBeenCalledTimes(2)
    for (const [sql] of execute.mock.calls) expect(isRetrySafeStatement(sql)).toBe(true)
  })
})
