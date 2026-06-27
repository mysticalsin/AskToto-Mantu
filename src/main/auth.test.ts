import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { requireAuth, authStatus } from './auth'

vi.mock('electron')

// The auth trust boundary (requireAuth) gates every privileged IPC handler in the main process.
// These tests cover the fail-open default and the fail-closed overrides (R-01 / R-17).
describe('auth trust boundary — requireAuth / authStatus', () => {
  let ud: string
  const AZURE_ENV = ['AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'ASKTOTO_ALLOWED_DOMAIN', 'ASKTOTO_REQUIRE_AUTH']

  beforeEach(() => {
    ud = mkdtempSync(join(tmpdir(), 'asktoto-auth-test-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((n: string) =>
      n === 'userData' ? ud : join(ud, n)
    )
    for (const k of AZURE_ENV) delete process.env[k]
  })
  afterEach(() => {
    rmSync(ud, { recursive: true, force: true })
    for (const k of AZURE_ENV) delete process.env[k]
    vi.restoreAllMocks()
  })

  it('fail-open by default when SSO is unconfigured (single-user)', () => {
    expect(authStatus().configured).toBe(false)
    expect(requireAuth()).toBe(true) // unconfigured → allowed (OS account is the gate)
  })

  it('is configured + fail-closed when Azure env IDs are present and the user is signed out', () => {
    process.env.AZURE_CLIENT_ID = 'client-id'
    process.env.AZURE_TENANT_ID = 'tenant-id'
    process.env.ASKTOTO_ALLOWED_DOMAIN = 'mantu.com'
    expect(authStatus().configured).toBe(true)
    expect(authStatus().signedIn).toBe(false)
    expect(requireAuth()).toBe(false) // configured + signed out → blocked
  })

  it('fail-CLOSED via ASKTOTO_REQUIRE_AUTH=1 even when SSO is unconfigured', () => {
    process.env.ASKTOTO_REQUIRE_AUTH = '1'
    expect(authStatus().configured).toBe(false)
    expect(requireAuth()).toBe(false) // override → require a signed-in session
  })

  it('fail-CLOSED via managed-config { requireAuth: true }', () => {
    writeFileSync(join(ud, 'managed-config.json'), JSON.stringify({ requireAuth: true }), 'utf8')
    expect(requireAuth()).toBe(false)
  })
})
