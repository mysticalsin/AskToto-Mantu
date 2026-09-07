import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from '../index'
import { memoryStore, type SeatRow } from '../store'
import { verifyOperatorLicense } from '../../../src/shared/operator-license'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY } from '../test-fixtures'

const NOW = 1_725_000_000_000

function env(): Env {
  return { OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET, OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY, OPERATOR_SKILL_PRIVATE_KEY: '' }
}

const tonyAccess = { getIdentity: async () => ({ email: 'tony.walteur@gmail.com' }) }

function seat(overrides: Partial<SeatRow> & Pick<SeatRow, 'device_id'>): SeatRow {
  return {
    seat_hash: 'seat',
    os: 'darwin',
    app_version: '1.8.5',
    first_seen: NOW - 3_600_000,
    last_seen: NOW,
    country: 'CA',
    city: 'Longueuil',
    region: null,
    lat: null,
    lon: null,
    last_index_at: null,
    hostname: 'Amaris-Laptop',
    sso_email: 'a@amaris.com',
    license: null,
    approval: 'pending',
    license_jti: null,
    ...overrides
  }
}

async function call(
  method: string,
  path: string,
  store: ReturnType<typeof memoryStore>,
  body?: unknown,
  headers: Record<string, string> = {}
) {
  return handleRequest(
    new Request(`https://operator.test${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    }),
    env(),
    { access: tonyAccess },
    { store, now: NOW }
  )
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T
}

describe('unauthenticated', () => {
  it('401s GET /v1/admin/groups without Access', async () => {
    const store = memoryStore()
    const res = await handleRequest(new Request('https://operator.test/v1/admin/groups'), env(), {}, { store, now: NOW })
    expect(res.status).toBe(401)
  })
})

describe('CSRF', () => {
  const cases: [string, string, unknown][] = [
    ['POST', '/v1/admin/groups', { name: 'Amaris', tier: 'metis' }],
    ['PATCH', '/v1/admin/groups/g1', { name: 'New' }],
    ['DELETE', '/v1/admin/groups/g1', undefined],
    ['POST', '/v1/admin/groups/g1/members', { member: 'a@amaris.com', kind: 'email' }],
    ['DELETE', '/v1/admin/groups/g1/members/a@amaris.com', undefined],
    ['POST', '/v1/admin/groups/g1/licenses/generate', { days: 30 }],
    ['PATCH', '/v1/admin/tiers/metis', { entitlements: ['ask'] }]
  ]
  for (const [method, path, body] of cases) {
    it(`refuses cross-site ${method} ${path} with code csrf`, async () => {
      const store = memoryStore()
      const res = await handleRequest(
        new Request(`https://operator.test${path}`, {
          method,
          headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {})
        }),
        env(),
        { access: tonyAccess },
        { store, now: NOW }
      )
      expect(res.status).toBe(403)
      expect((await json(res)).code).toBe('csrf')
    })
  }
})

describe('POST /v1/admin/groups', () => {
  it('rejects a name shorter than 2 characters with the value and length in the message', async () => {
    const store = memoryStore()
    const res = await call('POST', '/v1/admin/groups', store, { name: 'A', tier: 'metis' })
    expect(res.status).toBe(400)
    const body = await json<{ error: string }>(res)
    expect(body.error).toContain('2 to 60 characters')
    expect(body.error).toContain('"A"')
    expect(body.error).toContain('1 character')
  })

  it('seeds metis and metis-light on first read and accepts a valid create', async () => {
    const store = memoryStore()
    const res = await call('POST', '/v1/admin/groups', store, { name: 'Amaris', tier: 'metis', notes: 'pilot team' })
    expect(res.status).toBe(200)
    const body = await json<{ ok: boolean; group: { id: string; name: string; tier: string } }>(res)
    expect(body.ok).toBe(true)
    expect(body.group.name).toBe('Amaris')
    expect(body.group.id).toMatch(/^amaris-[a-f0-9]{6}$/)

    const tiers = await store.listTiers()
    expect(tiers.map((t) => t.id).sort()).toEqual(['metis', 'metis-light'])
    const audit = await store.listAudit(20)
    expect(audit.some((a) => a.action === 'tiers-seeded')).toBe(true)
    expect(audit.some((a) => a.action === 'group-create' && a.detail.includes(body.group.id))).toBe(true)
  })

  it('rejects a duplicate name case-insensitively', async () => {
    const store = memoryStore()
    await call('POST', '/v1/admin/groups', store, { name: 'Amaris', tier: 'metis' })
    const dup = await call('POST', '/v1/admin/groups', store, { name: 'amaris', tier: 'metis' })
    expect(dup.status).toBe(400)
    expect((await json<{ error: string }>(dup)).error).toContain('unique')
  })

  it('rejects a tier that does not exist, listing the valid tiers', async () => {
    const store = memoryStore()
    const res = await call('POST', '/v1/admin/groups', store, { name: 'Amaris', tier: 'bogus' })
    expect(res.status).toBe(400)
    const body = await json<{ error: string }>(res)
    expect(body.error).toContain('metis')
    expect(body.error).toContain('"bogus"')
  })

  it('does not reseed tiers on a second call', async () => {
    const store = memoryStore()
    await call('POST', '/v1/admin/groups', store, { name: 'Amaris', tier: 'metis' })
    await call('GET', '/v1/admin/groups', store)
    const audit = await store.listAudit(50)
    expect(audit.filter((a) => a.action === 'tiers-seeded')).toHaveLength(1)
  })
})

describe('GET /v1/admin/groups', () => {
  it('computes real member, license, live-seat and last-active counts, zero when there is no data', async () => {
    const store = memoryStore()
    const created = await json<{ group: { id: string } }>(await call('POST', '/v1/admin/groups', store, { name: 'Amaris', tier: 'metis' }))
    const groupId = created.group.id

    const empty = await json<{ groups: { members: number; licensesIssued: number; seatsLive: number; lastActiveAt: number | null }[] }>(
      await call('GET', '/v1/admin/groups', store)
    )
    expect(empty.groups[0]).toMatchObject({ members: 0, licensesIssued: 0, licensesActive: 0, seatsLive: 0, lastActiveAt: null })

    await store.putGroupMember({ group_id: groupId, member: 'a@amaris.com', kind: 'email', added_at: NOW, added_by: 'tony.walteur@gmail.com' })
    await store.upsertSeat(seat({ device_id: 'dev-amaris-1', sso_email: 'a@amaris.com', last_seen: NOW }))

    const generated = await json<{ jti: string }>(
      await call('POST', `/v1/admin/groups/${groupId}/licenses/generate`, store, { days: 30 })
    )
    expect(generated.jti).toBeTruthy()

    const populated = await json<{
      groups: { members: number; licensesIssued: number; licensesActive: number; seatsLive: number; lastActiveAt: number | null }[]
    }>(await call('GET', '/v1/admin/groups', store))
    expect(populated.groups[0]).toMatchObject({ members: 1, licensesIssued: 1, licensesActive: 1, seatsLive: 1, lastActiveAt: NOW })
  })
})

describe('GET /v1/admin/groups/:id', () => {
  it('returns members, licenses, seats and activity for the group', async () => {
    const store = memoryStore()
    const created = await json<{ group: { id: string } }>(await call('POST', '/v1/admin/groups', store, { name: 'Amaris', tier: 'metis' }))
    const groupId = created.group.id
    await call('POST', `/v1/admin/groups/${groupId}/members`, store, { member: 'a@amaris.com', kind: 'email' })
    await store.upsertSeat(seat({ device_id: 'dev-amaris-1', sso_email: 'a@amaris.com' }))
    await call('POST', `/v1/admin/groups/${groupId}/licenses/generate`, store, { days: 30, member: 'a@amaris.com' })

    const res = await call('GET', `/v1/admin/groups/${groupId}`, store)
    expect(res.status).toBe(200)
    const body = await json<{
      group: { id: string }
      members: { member: string; kind: string }[]
      licenses: { last4: string; tier: string; member: string | null }[]
      seats: { deviceId: string; deviceShortId: string; live: boolean; licenseState: string }[]
      activity: { action: string }[]
    }>(res)
    expect(body.group.id).toBe(groupId)
    expect(body.members).toEqual([{ member: 'a@amaris.com', kind: 'email', addedAt: NOW, addedBy: 'tony.walteur@gmail.com' }])
    expect(body.licenses).toHaveLength(1)
    expect(body.licenses[0].tier).toBe('metis')
    expect(body.licenses[0].member).toBe('a@amaris.com')
    expect(body.seats).toHaveLength(1)
    expect(body.seats[0].deviceId).toBe('dev-amaris-1')
    expect(body.seats[0].deviceShortId).toBe('dev-amar')
    expect(body.seats[0].live).toBe(true)
    expect(body.activity.some((a) => a.action === 'group-member-add')).toBe(true)
    expect(body.activity.some((a) => a.action === 'group-license-generate')).toBe(true)
  })

  it('404s for an unknown group id', async () => {
    const store = memoryStore()
    const res = await call('GET', '/v1/admin/groups/nope', store)
    expect(res.status).toBe(404)
  })
})

describe('PATCH /v1/admin/groups/:id', () => {
  it('updates name, tier and notes and audits the change', async () => {
    const store = memoryStore()
    const created = await json<{ group: { id: string } }>(await call('POST', '/v1/admin/groups', store, { name: 'Amaris', tier: 'metis' }))
    const groupId = created.group.id
    const res = await call('PATCH', `/v1/admin/groups/${groupId}`, store, { name: 'Amaris Canada', tier: 'metis-light', notes: 'renamed' })
    expect(res.status).toBe(200)
    const body = await json<{ group: { name: string; tier: string; notes: string } }>(res)
    expect(body.group).toMatchObject({ name: 'Amaris Canada', tier: 'metis-light', notes: 'renamed' })
    const audit = await store.listAudit(20)
    expect(audit.some((a) => a.action === 'group-update' && a.detail.includes(groupId))).toBe(true)
  })

  it('rejects an invalid tier on PATCH the same way as create', async () => {
    const store = memoryStore()
    const created = await json<{ group: { id: string } }>(await call('POST', '/v1/admin/groups', store, { name: 'Amaris', tier: 'metis' }))
    const res = await call('PATCH', `/v1/admin/groups/${created.group.id}`, store, { tier: 'bogus' })
    expect(res.status).toBe(400)
  })
})

describe('DELETE /v1/admin/groups/:id', () => {
  it('is refused with code has-active-licenses while an active license points at the group, then succeeds after revoke', async () => {
    const store = memoryStore()
    const created = await json<{ group: { id: string } }>(await call('POST', '/v1/admin/groups', store, { name: 'Amaris', tier: 'metis' }))
    const groupId = created.group.id
    const lic = await json<{ jti: string }>(await call('POST', `/v1/admin/groups/${groupId}/licenses/generate`, store, { days: 30 }))

    const refused = await call('DELETE', `/v1/admin/groups/${groupId}`, store)
    expect(refused.status).toBe(409)
    expect((await json<{ code: string }>(refused)).code).toBe('has-active-licenses')

    await store.revokeIssuedLicense(lic.jti, NOW)
    const ok = await call('DELETE', `/v1/admin/groups/${groupId}`, store)
    expect(ok.status).toBe(200)
    expect(await store.getGroup(groupId)).toBeNull()
  })
})

describe('members', () => {
  it('validates email shape and rejects an unknown device id, accepts a known one', async () => {
    const store = memoryStore()
    const created = await json<{ group: { id: string } }>(await call('POST', '/v1/admin/groups', store, { name: 'Amaris', tier: 'metis' }))
    const groupId = created.group.id

    const badEmail = await call('POST', `/v1/admin/groups/${groupId}/members`, store, { member: 'not-an-email', kind: 'email' })
    expect(badEmail.status).toBe(400)
    expect((await json<{ error: string }>(badEmail)).error).toContain('valid email address')

    const unknownDevice = await call('POST', `/v1/admin/groups/${groupId}/members`, store, { member: 'dev-nope', kind: 'device' })
    expect(unknownDevice.status).toBe(400)
    expect((await json<{ error: string }>(unknownDevice)).error).toContain('no seat with that device id')

    await store.upsertSeat(seat({ device_id: 'dev-known-1' }))
    const goodDevice = await call('POST', `/v1/admin/groups/${groupId}/members`, store, { member: 'dev-known-1', kind: 'device' })
    expect(goodDevice.status).toBe(200)

    const list = await store.listGroupMembers(groupId)
    expect(list.map((m) => m.member)).toEqual(['dev-known-1'])
  })

  it('removes a member by path param, case-insensitively for email', async () => {
    const store = memoryStore()
    const created = await json<{ group: { id: string } }>(await call('POST', '/v1/admin/groups', store, { name: 'Amaris', tier: 'metis' }))
    const groupId = created.group.id
    await call('POST', `/v1/admin/groups/${groupId}/members`, store, { member: 'a@amaris.com', kind: 'email' })

    const res = await call('DELETE', `/v1/admin/groups/${groupId}/members/A@AMARIS.COM`, store)
    expect(res.status).toBe(200)
    expect(await store.listGroupMembers(groupId)).toHaveLength(0)
  })

  it('scrubs a newline and a secret-shaped substring out of a device id before it reaches the audit trail', async () => {
    const store = memoryStore()
    const created = await json<{ group: { id: string } }>(await call('POST', '/v1/admin/groups', store, { name: 'Amaris', tier: 'metis' }))
    const groupId = created.group.id
    const secretSubstring = 'sk-ant-api03-totallyfakefakefake99'
    const weirdDeviceId = `dev-weird\n${secretSubstring}`
    await store.upsertSeat(seat({ device_id: weirdDeviceId }))

    const res = await call('POST', `/v1/admin/groups/${groupId}/members`, store, { member: weirdDeviceId, kind: 'device' })
    expect(res.status).toBe(200)

    const audit = await store.listAudit(20)
    const addRow = audit.find((a) => a.action === 'group-member-add')
    expect(addRow?.detail).toBeTruthy()
    expect(addRow?.detail).not.toContain('\n')
    expect(addRow?.detail).not.toContain(secretSubstring)
  })
})

describe('POST /v1/admin/groups/:id/licenses/generate', () => {
  it('mints a license that verifies, defaults tier to the group tier, and stores group_id + tier on the issued row', async () => {
    const store = memoryStore()
    const created = await json<{ group: { id: string } }>(await call('POST', '/v1/admin/groups', store, { name: 'Amaris', tier: 'metis-light' }))
    const groupId = created.group.id

    const res = await call('POST', `/v1/admin/groups/${groupId}/licenses/generate`, store, { days: 90, member: 'a@amaris.com' })
    expect(res.status).toBe(200)
    const body = await json<{ license: string; jti: string; tier: string; groupId: string; member: string }>(res)
    expect(body.license.startsWith('METIS-OP-1.')).toBe(true)
    expect(body.tier).toBe('metis-light')
    expect(body.groupId).toBe(groupId)

    const verified = await verifyOperatorLicense(TEST_INGEST_SECRET, body.license, NOW)
    expect(verified.ok).toBe(true)

    const stored = await store.getIssuedLicense(body.jti)
    expect(stored?.group_id).toBe(groupId)
    expect(stored?.tier).toBe('metis-light')
    expect(stored?.member).toBe('a@amaris.com')
    expect(JSON.stringify(stored)).not.toContain(body.license)
  })

  it('honours an explicit tier override and rejects an unknown one', async () => {
    const store = memoryStore()
    const created = await json<{ group: { id: string } }>(await call('POST', '/v1/admin/groups', store, { name: 'Amaris', tier: 'metis' }))
    const groupId = created.group.id

    const override = await json<{ tier: string }>(
      await call('POST', `/v1/admin/groups/${groupId}/licenses/generate`, store, { days: 7, tier: 'metis-light' })
    )
    expect(override.tier).toBe('metis-light')

    const bad = await call('POST', `/v1/admin/groups/${groupId}/licenses/generate`, store, { days: 7, tier: 'bogus' })
    expect(bad.status).toBe(400)
  })

  it('rejects a member that is neither a valid email nor an existing seat device id', async () => {
    const store = memoryStore()
    const created = await json<{ group: { id: string } }>(await call('POST', '/v1/admin/groups', store, { name: 'Amaris', tier: 'metis' }))
    const groupId = created.group.id

    const res = await call('POST', `/v1/admin/groups/${groupId}/licenses/generate`, store, {
      days: 30,
      member: 'not-an-email-or-device'
    })
    expect(res.status).toBe(400)
    const body = await json<{ error: string }>(res)
    expect(body.error).toContain('not-an-email-or-device')
    expect(await store.listIssuedLicenses()).toHaveLength(0)
  })
})

describe('GET /v1/admin/tiers', () => {
  it('seeds and returns metis and metis-light with entitlements and a real seat count per tier', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-1', approval: 'approved' }))
    const res = await call('GET', '/v1/admin/tiers', store)
    expect(res.status).toBe(200)
    const body = await json<{ tiers: { id: string; entitlements: string[]; seats: number }[] }>(res)
    const metis = body.tiers.find((t) => t.id === 'metis')
    expect(metis?.entitlements).toContain('ask')
    expect(metis?.seats).toBe(1)
    const light = body.tiers.find((t) => t.id === 'metis-light')
    expect(light?.seats).toBe(0)
  })
})

describe('PATCH /v1/admin/tiers/:id', () => {
  it('rejects an unknown entitlement, listing the valid ones', async () => {
    const store = memoryStore()
    await call('GET', '/v1/admin/tiers', store)
    const res = await call('PATCH', '/v1/admin/tiers/metis', store, { entitlements: ['ask', 'telepathy'] })
    expect(res.status).toBe(400)
    const body = await json<{ error: string }>(res)
    expect(body.error).toContain('telepathy')
    expect(body.error).toContain('ask, listen, recap, crm_push, operator_keys, intelligence, integrations')
  })

  it('accepts a valid entitlement set, persists it, and audits both the before and after lists', async () => {
    const store = memoryStore()
    await call('GET', '/v1/admin/tiers', store)
    // metis-light seeds as ['ask', 'intelligence'] (DEFAULT_TIER_ENTITLEMENTS).
    const res = await call('PATCH', '/v1/admin/tiers/metis-light', store, { entitlements: ['ask', 'listen'], label: 'Métis Light' })
    expect(res.status).toBe(200)
    const tiers = await store.listTiers()
    const light = tiers.find((t) => t.id === 'metis-light')
    expect(JSON.parse(light?.entitlements_json ?? '[]')).toEqual(['ask', 'listen'])
    const audit = await store.listAudit(20)
    const tierUpdateRow = audit.find((a) => a.action === 'tier-update')
    expect(tierUpdateRow).toBeTruthy()
    expect(tierUpdateRow?.detail).toContain('ask, intelligence')
    expect(tierUpdateRow?.detail).toContain('ask, listen')
  })

  it('caps label at 60 characters after trim', async () => {
    const store = memoryStore()
    await call('GET', '/v1/admin/tiers', store)
    const res = await call('PATCH', '/v1/admin/tiers/metis', store, { entitlements: ['ask'], label: `  ${'x'.repeat(10000)}  ` })
    expect(res.status).toBe(200)
    const body = await json<{ tier: { label: string } }>(res)
    expect(body.tier.label).toHaveLength(60)
    const tiers = await store.listTiers()
    expect(tiers.find((t) => t.id === 'metis')?.label).toHaveLength(60)
  })

  it('404s for an unknown tier id', async () => {
    const store = memoryStore()
    const res = await call('PATCH', '/v1/admin/tiers/bogus', store, { entitlements: ['ask'] })
    expect(res.status).toBe(404)
  })
})
