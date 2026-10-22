import { describe, expect, it } from 'vitest'
import { buildDashboard, NO_ENROLLMENT, type DashboardEnrollment, type DashboardPayload } from '../../dashboard'
import { memoryStore, type IssuedLicenseRow, type SeatRow } from '../../store'
import { fixtureDashboard } from '../fixture'
import { renderEnrollmentPanel } from './enrollment-panel'
import { renderLicenses } from './licenses'
import { renderSettings } from './settings'

const NOW = 1_800_000_000_000
const CTX = { now: NOW, theme: 'light' as const }

const token = (over: Partial<DashboardEnrollment['tokens'][number]> = {}): DashboardEnrollment['tokens'][number] => ({
  kid: 'abcdef0123456789',
  label: 'Release 2.12',
  channel: 'release',
  tier: 'reporting',
  licenseDays: 30,
  maxDevices: 5000,
  dailyCap: 500,
  enrolledCount: 3,
  enrolledToday: 1,
  createdAt: NOW - 86400_000,
  createdBy: 'owner@example.test',
  expiresAt: NOW + 86400_000 * 100,
  status: 'active',
  revokedAt: null,
  revokedBy: null,
  revokeReason: null,
  ...over
})

async function withEnrollment(over: Partial<DashboardEnrollment>): Promise<DashboardPayload> {
  const data = await fixtureDashboard()
  return { ...data, enrollment: { ...NO_ENROLLMENT, ...over } }
}

describe('Settings > Enrolment panel', () => {
  it('shows the owner every control, the token table, and a revoke with a cascade option naming the device count', async () => {
    const html = renderEnrollmentPanel(
      await withEnrollment({
        isOwner: true,
        tierIds: ['metis', 'metis-light'],
        sso: { configured: true, tenantLast4: '5555', clientIdCount: 1, domainCount: 2 },
        tokens: [token(), token({ kid: '1111111111111111', label: 'Old', status: 'revoked', revokedAt: NOW - 1000 })]
      })
    )
    for (const hook of [
      'data-enroll-panel',
      'data-enroll-settings',
      'data-enroll-create',
      'data-enroll-once',
      'data-enroll-pause="true"'
    ]) {
      expect(html).toContain(hook)
    }
    expect(html).toContain('Store this as the CI secret, it will not be shown again.')
    expect(html).toContain('data-enroll-revoke="abcdef0123456789"')
    expect(html).toContain('also revoke the 3 devices enrolled with this token')
    // A revoked token cannot be revoked again.
    expect(html).not.toContain('data-enroll-revoke="1111111111111111"')
    expect(html).toContain('data-enroll-token-status="revoked"')
    expect(html).toContain('<option value="reporting" selected>')
    expect(html).toContain('3 / 5000')
    expect(html).toContain('1 / 500')
    expect(html).not.toContain('style="')
    expect(html).not.toContain('—')
  })

  it('is read-only for a non-owner: no form, no pause, no revoke, and it says why', async () => {
    const html = renderEnrollmentPanel(await withEnrollment({ isOwner: false, tokens: [token()] }))
    expect(html).toContain('Only the fleet owner can change enrolment.')
    for (const hook of [
      'data-enroll-settings',
      'data-enroll-create',
      'data-enroll-pause',
      'data-enroll-revoke',
      'data-enroll-once'
    ]) {
      expect(html).not.toContain(hook)
    }
    expect(html).toContain('Release 2.12')
  })

  it('states honestly when enrolment is paused and offers Resume to the owner', async () => {
    const html = renderEnrollmentPanel(
      await withEnrollment({
        isOwner: true,
        settings: { paused: true, ssoTier: 'reporting', ssoMaxDevicesPerUser: 10 }
      })
    )
    expect(html).toContain('data-enroll-state="paused"')
    expect(html).toContain('Enrolment is paused.')
    expect(html).toContain('Seats that are already enrolled keep working.')
    expect(html).toContain('data-enroll-pause="false"')
    expect(html).toContain('Resume enrolment')
  })

  it('shows SSO status without ever showing a configured value: last 4 of the tenant, counts for the rest', async () => {
    const on = renderEnrollmentPanel(
      await withEnrollment({ sso: { configured: true, tenantLast4: '5555', clientIdCount: 2, domainCount: 1 } })
    )
    expect(on).toContain('data-enroll-sso="on"')
    expect(on).toContain('tenant ··5555, 2 client ids, 1 allowed domain')
    const off = renderEnrollmentPanel(await withEnrollment({}))
    expect(off).toContain('data-enroll-sso="off"')
    expect(off).toContain('ENROLL_SSO_TENANT_ID')
    expect(off).toContain('ENROLL_SSO_CLIENT_IDS')
    expect(off).toContain('ENROLL_SSO_ALLOWED_DOMAINS')
  })

  it('has an honest empty state and never renders a secret, a hash or a full token', async () => {
    const empty = renderEnrollmentPanel(await withEnrollment({ isOwner: true }))
    expect(empty).toContain('No enrolment tokens yet.')
    const filled = renderEnrollmentPanel(await withEnrollment({ isOwner: true, tokens: [token()] }))
    expect(filled).not.toMatch(/METIS-ENR-1/)
    expect(filled).not.toMatch(/secret_hash|[a-f0-9]{64}/)
    // Only the last 6 characters of the public kid appear.
    expect(filled).toContain('··456789')
    expect(filled).not.toContain('abcdef0123456789</td>')
  })

  it('is part of the Settings page, which keeps its existing cards', async () => {
    const html = renderSettings(await withEnrollment({ isOwner: true }), CTX)
    expect(html).toContain('Access keep')
    expect(html).toContain('data-enroll-panel')
    expect(html).not.toContain('style="')
  })

  it('escapes a hostile token label', async () => {
    const html = renderEnrollmentPanel(
      await withEnrollment({ tokens: [token({ label: '<img src=x onerror=alert(1)>' })] })
    )
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x')
  })
})

describe('Source column on the Licenses page (honesty)', () => {
  const seat = (id: string, over: Partial<SeatRow> = {}): SeatRow => ({
    device_id: id,
    seat_hash: id,
    os: 'darwin',
    app_version: '2.12.0',
    first_seen: NOW - 1000,
    last_seen: NOW - 500,
    country: null,
    city: null,
    lat: null,
    lon: null,
    last_index_at: null,
    hostname: `host-${id}`,
    sso_email: null,
    license: null,
    approval: 'pending',
    ...over
  })

  async function payload(): Promise<DashboardPayload> {
    const store = memoryStore()
    await store.upsertSeat(seat('device-admin-1', { approval: 'approved' }))
    await store.upsertSeat(
      seat('device-sso-0001', {
        sso_email: 'claimed@example.test',
        enroll_method: 'sso',
        sso_verified_email: 'verified@example.test'
      })
    )
    await store.upsertSeat(seat('device-tok-0001', { sso_email: 'liar@example.test', enroll_method: 'token' }))
    const lic = (jti: string, over: Partial<IssuedLicenseRow>): IssuedLicenseRow => ({
      jti,
      last4: jti.slice(-4),
      key_hash: jti,
      days: 30,
      iat: 1,
      exp: NOW / 1000 + 86400,
      revoked: 0,
      created_at: NOW - 1000,
      created_by: 'x',
      ...over
    })
    await store.putIssuedLicense(lic('aaaaaaaaaaaaaaa1', {}))
    await store.putIssuedLicense(lic('aaaaaaaaaaaaaaa2', { origin: 'sso-enroll', member: 'verified@example.test' }))
    await store.putIssuedLicense(lic('aaaaaaaaaaaaaaa3', { origin: 'token-enroll', member: 'device:device-tok-0001' }))
    return buildDashboard(store, 'owner@example.test', NOW)
  }

  it('derives each seat and licence Source from the enrolment method, never from the device-claimed e-mail', async () => {
    const data = await payload()
    const byDevice = Object.fromEntries(data.licenses.rows.map((r) => [r.device, r.source]))
    expect(byDevice['device-admin-1']).toEqual({ kind: 'admin', email: null })
    expect(byDevice['device-sso-0001']).toEqual({ kind: 'sso', email: 'verified@example.test' })
    expect(byDevice['device-tok-0001']).toEqual({ kind: 'token', email: null })
    expect(data.licenses.issued.map((i) => i.source.kind).sort()).toEqual(['admin', 'sso', 'token'])
    expect(data.enrollment).toEqual(NO_ENROLLMENT)
  })

  it('renders Admin, SSO with the verified e-mail, and Token · Unverified, with a filter and no inline style', async () => {
    const html = renderLicenses(await payload(), CTX)
    expect(html).toContain('<th>Source</th>')
    expect(html).toContain('data-source-pill="admin"')
    expect(html).toContain('data-source-pill="sso"')
    expect(html).toContain('data-source-pill="token"')
    expect(html).toContain('Token · Unverified')
    expect(html).toContain('verified@example.test')
    expect(html).toContain('data-source-filter')
    expect(html).toContain('data-source-filter-empty')
    for (const kind of ['admin', 'sso', 'token']) expect(html).toContain(`data-source="${kind}"`)
    expect(html).not.toContain('style="')
  })

  it('marks an e-mail a token-enrolled device merely claims as unverified', async () => {
    const html = renderLicenses(await payload(), CTX)
    expect(html).toContain('liar@example.test <span class="muted">(unverified)</span>')
    // The claimed e-mail of a verified SSO seat is not what the Source cell shows.
    expect(html).toContain('verified@example.test')
  })

  it('renders every pre-existing seat as Admin (no enrolment history changes what it was)', async () => {
    const data = await fixtureDashboard()
    expect(data.licenses.rows.length).toBeGreaterThan(0)
    expect(new Set(data.licenses.rows.map((r) => r.source.kind))).toEqual(new Set(['admin']))
  })
})
