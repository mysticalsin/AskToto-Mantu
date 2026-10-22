import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ctx = vi.hoisted(() => ({
  dir: '',
  settings: {} as Record<string, unknown>,
  confirm: vi.fn(),
  accept: vi.fn(),
  requireAuth: vi.fn(() => true)
}))
vi.mock('electron', () => ({ app: { getPath: () => ctx.dir } }))
vi.mock('./logger', () => ({ auditLog: () => {}, mainLog: { warn: () => {} } }))
vi.mock('./auth', () => ({ requireAuth: ctx.requireAuth }))
vi.mock('./store', () => ({
  getSettings: () => ctx.settings,
  setSettings: (patch: Record<string, unknown>) => {
    ctx.settings = { ...ctx.settings, ...patch }
  }
}))
vi.mock('./operator-ingest', () => ({
  confirmOperatorLicenseConnection: ctx.confirm,
  acceptOperatorHeartbeat: ctx.accept
}))

import {
  activateOperatorLicenseFromIpc,
  applyAutoLicense,
  configureOperatorLicenseService,
  currentAutoLicense,
  demoteAutoLicense,
  dropAutoLicense,
  promoteAutoLicense,
  revokeAutoSeat
} from './operator-license-service'
import { enqueuePreEnrolItem, loadQueueState } from './operator-queue'

const SECONDS = Math.floor(Date.now() / 1000)
const mint = (jti: string): string => `METIS-OP-1.${jti}.${SECONDS - 60}.${SECONDS + 86_400}.AAAAAAAAAAAAAAAAAAAA`
const AUTO = mint('aaaaaaaaaaaaaaaa')
const ADMIN = mint('bbbbbbbbbbbbbbbb')
const BASE = { operatorUrl: 'https://operator.test', operatorLicenseToken: '', operatorIngestSecret: '' }

const restart = vi.fn()
const changed = vi.fn()

beforeEach(() => {
  ctx.dir = mkdtempSync(join(tmpdir(), 'operator-license-service-'))
  ctx.settings = { ...BASE, operatorEnrollState: 'unenrolled', operatorLicenseOrigin: null, operatorReportingToken: '' }
  ctx.confirm.mockReset().mockResolvedValue({ ok: true, confirmation: { ok: true, approved: true, tier: 'reporting' } })
  ctx.accept.mockReset()
  ctx.requireAuth.mockReturnValue(true)
  restart.mockReset()
  changed.mockReset()
  configureOperatorLicenseService({ restartRuntime: restart, notifyChanged: changed })
})
afterEach(() => rmSync(ctx.dir, { recursive: true, force: true }))

describe('applyAutoLicense', () => {
  it('stores the licence in the reporting slot only, so no gate ever sees it', async () => {
    expect(await applyAutoLicense(AUTO, 'sso')).toEqual({ ok: true })
    expect(ctx.settings).toMatchObject({
      operatorReportingToken: AUTO,
      operatorReportingJti: 'aaaaaaaaaaaaaaaa',
      operatorLicenseOrigin: 'sso',
      operatorEnrollState: 'enrolled',
      operatorLicenseToken: '',
      operatorTier: null
    })
    expect(restart).toHaveBeenCalledTimes(1)
    expect(ctx.accept).toHaveBeenCalledTimes(1)
  })
  it('saves nothing when the Worker does not confirm the licence', async () => {
    ctx.confirm.mockResolvedValue({ ok: false, error: 'nope' })
    expect(await applyAutoLicense(AUTO, 'token')).toEqual({ ok: false, error: 'nope' })
    expect(ctx.settings.operatorReportingToken).toBe('')
    expect(restart).not.toHaveBeenCalled()
  })
  it('refuses to replace an administrator licence', async () => {
    ctx.settings = { ...ctx.settings, operatorLicenseToken: ADMIN, operatorLicenseOrigin: 'admin' }
    expect((await applyAutoLicense(AUTO, 'sso')).ok).toBe(false)
    expect(ctx.settings.operatorLicenseToken).toBe(ADMIN)
    expect(ctx.confirm).not.toHaveBeenCalled()
  })
  it('renews a promoted licence in the managed slot', async () => {
    ctx.settings = { ...ctx.settings, operatorLicenseToken: AUTO, operatorLicenseOrigin: 'sso' }
    const renewed = mint('cccccccccccccccc')
    await applyAutoLicense(renewed, 'sso')
    expect(ctx.settings).toMatchObject({ operatorLicenseToken: renewed, operatorReportingToken: '' })
    expect(currentAutoLicense()?.token).toBe(renewed)
  })
})

describe('promote and demote', () => {
  it('moves the licence between slots as the confirmed tier changes', async () => {
    await applyAutoLicense(AUTO, 'sso')
    expect(promoteAutoLicense()).toBe(true)
    expect(ctx.settings).toMatchObject({
      operatorLicenseToken: AUTO,
      operatorReportingToken: '',
      operatorLicenseOrigin: 'sso'
    })
    expect(promoteAutoLicense()).toBe(false)
    expect(demoteAutoLicense()).toBe(true)
    expect(ctx.settings).toMatchObject({ operatorLicenseToken: '', operatorReportingToken: AUTO })
    expect(demoteAutoLicense()).toBe(false)
  })
})

describe('revoke and drop', () => {
  it('revoke discards the licence and the queue and remembers when it checked', async () => {
    await applyAutoLicense(AUTO, 'token')
    enqueuePreEnrolItem(ctx.dir, { path: '/v1/ingest', body: { id: 'x' } })
    revokeAutoSeat(5_000)
    expect(ctx.settings).toMatchObject({
      operatorReportingToken: '',
      operatorEnrollState: 'revoked',
      operatorEnrollCheckedAt: 5_000,
      operatorLicenseOrigin: null
    })
    expect(loadQueueState(ctx.dir).items).toHaveLength(0)
  })
  it('drop forgets an expired auto licence so enrolment starts again', async () => {
    await applyAutoLicense(AUTO, 'token')
    dropAutoLicense()
    expect(ctx.settings).toMatchObject({ operatorReportingToken: '', operatorEnrollState: 'unenrolled' })
  })
  it('neither touches an administrator licence', () => {
    ctx.settings = {
      ...ctx.settings,
      operatorLicenseToken: ADMIN,
      operatorLicenseOrigin: 'admin',
      operatorEnrollState: 'unenrolled'
    }
    revokeAutoSeat(1)
    dropAutoLicense()
    expect(ctx.settings).toMatchObject({
      operatorLicenseToken: ADMIN,
      operatorLicenseOrigin: 'admin',
      operatorEnrollState: 'unenrolled'
    })
  })
})

describe('activateOperatorLicenseFromIpc (admin path)', () => {
  it('requires sign-in', async () => {
    ctx.requireAuth.mockReturnValue(false)
    expect((await activateOperatorLicenseFromIpc({ licenseKey: ADMIN })).ok).toBe(false)
  })
  it('activates with origin admin and clears any auto licence', async () => {
    await applyAutoLicense(AUTO, 'sso')
    ctx.confirm.mockResolvedValue({ ok: true, confirmation: { ok: true, approved: true, tier: 'metis' } })
    const result = await activateOperatorLicenseFromIpc({ licenseKey: ADMIN })
    expect(result.ok).toBe(true)
    expect(ctx.settings).toMatchObject({
      operatorLicenseToken: ADMIN,
      operatorLicenseOrigin: 'admin',
      operatorReportingToken: '',
      operatorEnrollState: 'unenrolled'
    })
  })
  it('clearing the licence purges the queue and returns the install to unenrolled', async () => {
    ctx.settings = { ...ctx.settings, operatorLicenseToken: ADMIN, operatorLicenseOrigin: 'admin' }
    enqueuePreEnrolItem(ctx.dir, { path: '/v1/ingest', body: { id: 'x' } })
    expect(await activateOperatorLicenseFromIpc({ licenseKey: '' })).toEqual({ ok: true })
    expect(ctx.settings).toMatchObject({ operatorLicenseToken: '', operatorLicenseOrigin: null })
    expect(loadQueueState(ctx.dir).items).toHaveLength(0)
  })
  it('rejects a malformed licence without a network call', async () => {
    expect((await activateOperatorLicenseFromIpc({ licenseKey: 'garbage' })).ok).toBe(false)
    expect(ctx.confirm).not.toHaveBeenCalled()
  })
})
