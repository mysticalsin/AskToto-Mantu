import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_OPERATOR_URL } from '@shared/operator'
import {
  operatorHeartbeat,
  recordOperatorAsk,
  setOperatorFetchForTests,
  setOperatorQueueDirForTests,
  stopOperatorRuntime
} from './operator-ingest'
import { configureOperatorEnrollment, enrollmentTick } from './operator-enrollment'
import { loadQueueState } from './operator-queue'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '1.8.0-test' }
}))
vi.mock('./license', () => ({
  getMachineId: () => 'machine-test-default-url',
  getDurableMachineId: () => 'machine-test-default-url'
}))
vi.mock('./logger', () => ({
  mainLog: { warn: () => {}, info: () => {}, error: () => {} },
  setAuditActor: () => {},
  auditLog: () => {}
}))

const metadata = vi.hoisted(() => {
  const settings = {
    operatorUrl: '',
    operatorIngestSecret: '',
    operatorTier: 'none',
    operatorEntitlements: null,
    operatorEntitlementsAt: 0,
    operatorIntegrationsVersion: 0,
    meetingsFolder: '/private/tmp/metis-operator-default-url-metadata-never-read'
  }
  return {
    settings,
    getSettings: vi.fn(() => settings),
    setSettings: vi.fn(),
    authStatus: vi.fn(() => ({ signedIn: false })),
    lastIndexedAt: vi.fn(() => 1_700_000_000_111)
  }
})
vi.mock('./store', () => ({ getSettings: metadata.getSettings, setSettings: metadata.setSettings }))
vi.mock('./auth', () => ({ authStatus: metadata.authStatus }))
vi.mock('./brain/intelligence-index', () => ({ lastIndexedAt: metadata.lastIndexedAt }))

let queueDir: string
beforeEach(() => {
  metadata.getSettings.mockClear()
  metadata.authStatus.mockClear()
  metadata.lastIndexedAt.mockClear()
  queueDir = mkdtempSync(join(tmpdir(), 'operator-default-url-test-'))
  setOperatorQueueDirForTests(queueDir)
})

afterEach(() => {
  setOperatorFetchForTests(null)
  setOperatorQueueDirForTests(null)
  stopOperatorRuntime()
  rmSync(queueDir, { recursive: true, force: true })
})

describe('operatorHeartbeat DEFAULT_OPERATOR_URL fallback', () => {
  it('phones home to DEFAULT when Settings operatorUrl is empty (secret required)', async () => {
    const calls: { url: string }[] = []
    setOperatorFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input) })
      return new Response('{"ok":true,"fundedProviders":[]}', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }) as typeof fetch)

    const r = await operatorHeartbeat({
      operatorUrl: '',
      operatorIngestSecret: 'shared-secret-for-tests'
    })
    expect(r.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${DEFAULT_OPERATOR_URL}/v1/heartbeat`)
    expect(metadata.lastIndexedAt).toHaveBeenCalledWith(metadata.settings)
  })

  it('treats a whitespace-only Settings Operator URL as empty and still phones DEFAULT', async () => {
    const calls: { url: string }[] = []
    setOperatorFetchForTests((async (input: string | URL | Request) => {
      calls.push({ url: String(input) })
      return new Response('{"ok":true,"fundedProviders":[]}', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }) as typeof fetch)

    const r = await operatorHeartbeat({
      operatorUrl: '   ',
      operatorIngestSecret: 'shared-secret-for-tests'
    })
    expect(r.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${DEFAULT_OPERATOR_URL}/v1/heartbeat`)
  })

  it('sends no heartbeat without a credential, even when DEFAULT resolves', async () => {
    const calls: string[] = []
    setOperatorFetchForTests((async (input: string | URL | Request) => {
      calls.push(String(input))
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch)

    const r = await operatorHeartbeat({ operatorUrl: '', operatorIngestSecret: '' })
    expect(r.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('queues ingest before enrolment and never POSTs it (zero-config reporting, O08/O09)', async () => {
    const calls: string[] = []
    setOperatorFetchForTests((async (input: string | URL | Request) => {
      calls.push(String(input))
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch)

    await recordOperatorAsk({ operatorUrl: '', operatorIngestSecret: '' }, { id: 'ask-pre-enrol', mode: 'answer' })
    expect(calls).toHaveLength(0)
    const queued = loadQueueState(queueDir).items
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ path: '/v1/ingest', preEnrol: true })
    expect(queued[0].body).toMatchObject({ id: 'ask-pre-enrol' })
  })

  it('enrolment POSTs only to /v1/enroll on the resolved base', async () => {
    const calls: { url: string; method?: string }[] = []
    configureOperatorEnrollment({
      getSettings: () => ({ operatorUrl: '', operatorEnrollState: 'unenrolled' }),
      now: () => 1_800_000_000_000,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method })
        return new Response('{"ok":false,"code":"enroll-paused"}', {
          status: 503,
          headers: { 'content-type': 'application/json' }
        })
      }) as typeof fetch,
      deviceId: () => 'device-hash',
      idToken: async () => null,
      signedIn: () => false,
      embeddedToken: () => ({ token: 'METIS-ENR-1.kid0kid0.secretsecret', operatorUrl: DEFAULT_OPERATOR_URL }),
      currentLicense: () => null,
      applyAutoLicense: async () => ({ ok: false }),
      promote: () => {},
      demote: () => {},
      drop: () => {},
      revoke: () => {},
      noteRevokedChecked: () => {},
      appVersion: () => '2.12.0-test',
      os: () => 'test'
    })
    await enrollmentTick('contract')
    expect(calls).toEqual([{ url: `${DEFAULT_OPERATOR_URL}/v1/enroll`, method: 'POST' }])
    configureOperatorEnrollment(null)
  })
})

describe('Open Operator uses resolveOperatorBaseUrl', () => {
  const source = readFileSync(join(__dirname, 'index.ts'), 'utf8').replace(/\r\n/g, '\n')

  it('opens the resolved HTTPS base so empty Settings still reach the shipped Worker', () => {
    const start = source.indexOf('ipcMain.handle(IPC.operatorOpen')
    expect(start).toBeGreaterThan(-1)
    const block = source.slice(start, source.indexOf('ipcMain.handle(IPC.licenseActivate', start))
    expect(block).toMatch(/resolveOperatorBaseUrl\(getSettings\(\)\)/)
    expect(block).not.toMatch(/getSettings\(\)\.operatorUrl \|\| process\.env\.METIS_OPERATOR_URL/)
  })
})
