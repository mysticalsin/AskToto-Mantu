import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const h = vi.hoisted(() => ({
  installManagedCli: vi.fn(),
  managedCliEntry: vi.fn((): { entry: string; version: string } | null => null),
  importDustCliSession: vi.fn(),
  setApiKey: vi.fn(),
  setSettings: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  shell: { openPath: vi.fn() }
}))

vi.mock('./cli-installer', () => ({
  installManagedCli: h.installManagedCli,
  managedCliEntry: () => h.managedCliEntry()
}))

vi.mock('./dustcli', () => ({
  importDustCliSession: h.importDustCliSession
}))

vi.mock('./store', () => ({
  setApiKey: h.setApiKey,
  setSettings: h.setSettings
}))

import { detectDustCli, mockDustConnectPrivilegeSequence, runDustConnectInstall } from './dust-connect'
import { countDustPrivilegeSpawns } from '@shared/dust-connect'

describe('runDustConnectInstall — one consent, installed = live', () => {
  let userData: string
  let entry: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'dust-connect-'))
    entry = join(userData, 'managed-cli', 'dust', '0.4.5', 'package', 'dist', 'index.js')
    mkdirSync(join(entry, '..'), { recursive: true })
    writeFileSync(entry, 'module.exports = {}\n')
    h.managedCliEntry.mockReturnValue({ entry, version: '0.4.5' })
    h.installManagedCli.mockResolvedValue({ entry, version: '0.4.5' })
    h.importDustCliSession.mockResolvedValue({
      ok: true,
      token: 'tok',
      workspaceId: 'ws_mantu',
      baseUrl: 'https://dust.tt'
    })
    h.setApiKey.mockReset()
    h.setSettings.mockReset()
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('install + import is one privilege session and detect is live', async () => {
    const r = await runDustConnectInstall()
    expect(r.ok).toBe(true)
    expect(r.installed).toBe(true)
    expect(r.live).toBe(true)
    expect(r.workspaceId).toBe('ws_mantu')
    expect(r.privilegeSpawns).toBe(1)
    expect(h.setApiKey).toHaveBeenCalledWith('dust', 'tok')
    const detected = await detectDustCli({ hasKey: true, workspaceId: 'ws_mantu', workspaceName: 'Mantu' })
    expect(detected.installed).toBe(true)
    expect(detected.live).toBe(true)
    expect(detected.bin).toBe(entry)
  })

  it('after install, a missing session asks for login instead of fake Connected', async () => {
    h.importDustCliSession.mockResolvedValue({ ok: false, error: 'No Dust CLI session found.' })
    const r = await runDustConnectInstall()
    expect(r.installed).toBe(true)
    expect(r.live).toBe(false)
    expect(r.needsLogin).toBe(true)
    expect(r.privilegeSpawns).toBe(1)
    expect(h.setApiKey).not.toHaveBeenCalled()
  })

  it('Mac and Windows privilege plans are 1, never three elevations', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const plan = mockDustConnectPrivilegeSequence(platform)
      expect(plan.privilegeSpawns, platform).toBe(1)
      expect(plan.kinds).not.toContain('uac')
      expect(plan.kinds).not.toContain('sudo')
      expect(plan.kinds).not.toContain('npm-global')
      expect(countDustPrivilegeSpawns(plan.kinds.map((kind) => ({ kind, sessionId: 'x' })))).toBe(1)
    }
  })
})
