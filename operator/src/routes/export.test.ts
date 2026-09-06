import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from '../index'
import { memoryStore } from '../store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY } from '../test-fixtures'

const NOW = 1_725_000_000_000

function env(): Env {
  return { OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET, OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY, OPERATOR_SKILL_PRIVATE_KEY: '' }
}

const tonyAccess = { getIdentity: async () => ({ email: 'tony.walteur@gmail.com' }) }

async function readAll(res: Response): Promise<Uint8Array> {
  const buf = await res.arrayBuffer()
  return new Uint8Array(buf)
}

describe('GET /v1/admin/export.csv', () => {
  it('requires admin auth, same as every other admin route', async () => {
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/export.csv?table=audit'),
      env(),
      { access: { getIdentity: async () => null } },
      { store: memoryStore(), now: NOW }
    )
    expect(res.status).toBe(401)
  })

  it('rejects an unknown table with 400', async () => {
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/export.csv?table=vault_keys'),
      env(),
      { access: tonyAccess },
      { store: memoryStore(), now: NOW }
    )
    expect(res.status).toBe(400)
  })

  it('streams a BOM-prefixed CSV with the right content type, filename and no-store, and audits one export row', async () => {
    const store = memoryStore()
    await store.audit('a-1', NOW, 'tony.walteur@gmail.com', 'revoke-license', null, 'jti-1')
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/export.csv?table=audit'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/csv')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="metis-operator-audit-20240830-0640.csv"')
    const bytes = await readAll(res)
    // UTF-8 BOM (EF BB BF) at the raw byte level; a standard TextDecoder strips it back out on
    // decode, so the BOM itself is only observable before decoding.
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf])
    const text = new TextDecoder().decode(bytes)
    expect(text).toContain('revoke-license')

    const auditRows = await store.listAudit(10, { action: 'export' })
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0].detail).toContain('table audit format csv rows 1')
  })

  it('applies the actor filter from the query string', async () => {
    const store = memoryStore()
    await store.audit('a-1', NOW, 'tony.walteur@gmail.com', 'revoke-license', null, 'jti-1')
    await store.audit('a-2', NOW, 'system', 'platform.heartbeat', null, 'events 0')
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/export.csv?table=audit&actor=system'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    const text = new TextDecoder().decode(await readAll(res))
    expect(text).toContain('platform.heartbeat')
    expect(text).not.toContain('revoke-license')
  })
})

describe('GET /v1/admin/export.xlsx', () => {
  it('streams a workbook with the right content type and filename, and audits one export row', async () => {
    const store = memoryStore()
    await store.upsertSeat({
      device_id: 'dev-a',
      seat_hash: 'h',
      os: 'darwin',
      app_version: '1.8.5',
      first_seen: NOW,
      last_seen: NOW,
      country: 'CA',
      city: 'Longueuil',
      region: null,
      lat: null,
      lon: null,
      last_index_at: null,
      hostname: 'Tonys-MacBook-Pro',
      sso_email: 'twalteur@amaris.com',
      license: 'approved',
      approval: 'approved',
      license_jti: null
    })
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/export.xlsx?table=seats'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="metis-operator-seats-20240830-0640.xlsx"')
    const bytes = await readAll(res)
    // ZIP local file header signature at byte 0 (PK\x03\x04).
    expect(bytes[0]).toBe(0x50)
    expect(bytes[1]).toBe(0x4b)
    expect(bytes[2]).toBe(0x03)
    expect(bytes[3]).toBe(0x04)

    const auditRows = await store.listAudit(10, { action: 'export' })
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0].detail).toContain('table seats format xlsx rows 1')
  })

  it('rejects an unknown table with 400, same as the CSV route', async () => {
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/export.xlsx?table=nope'),
      env(),
      { access: tonyAccess },
      { store: memoryStore(), now: NOW }
    )
    expect(res.status).toBe(400)
  })
})
