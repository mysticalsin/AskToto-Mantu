import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from 'electron'

vi.mock('electron')

import {
  assignMemberNumber,
  formatInstalledLabel,
  memberNumberLabel,
  readInstallIdentity,
  writeInstallIdentity
} from './install'

describe('install identity', () => {
  let ud: string

  beforeEach(() => {
    ud = mkdtempSync(join(tmpdir(), 'metis-identity-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((n: string) => (n === 'userData' ? ud : join(ud, n)))
  })

  afterEach(() => {
    rmSync(ud, { recursive: true, force: true })
  })

  it('persists first-seen installedAt and never rewrites it', () => {
    const first = readInstallIdentity(ud)
    const stamped = '2026-03-19T08:11:00.000Z'
    writeFileSync(
      join(ud, 'identity.json'),
      JSON.stringify({ ...first, installedAt: stamped, memberNumber: null, memberNumberAssignedAt: null })
    )
    const again = readInstallIdentity(ud)
    expect(again.installedAt).toBe(stamped)
    const patched = writeInstallIdentity({ installedAt: '2099-01-01T00:00:00.000Z' } as never, ud)
    expect(patched.installedAt).toBe(stamped)
    const disk = JSON.parse(readFileSync(join(ud, 'identity.json'), 'utf8')) as { installedAt: string }
    expect(disk.installedAt).toBe(stamped)
    expect(formatInstalledLabel(stamped)).toBe('Installed 19 Mar 2026')
  })

  it('keeps member number pending until a real assignment, then caches it', () => {
    const first = readInstallIdentity(ud)
    expect(first.memberNumber).toBeNull()
    expect(memberNumberLabel(first.memberNumber)).toBe('pending')
    writeInstallIdentity({ memberNumber: null }, ud)
    expect(readInstallIdentity(ud).memberNumber).toBeNull()
    writeInstallIdentity({ memberNumber: 0 as never }, ud)
    expect(readInstallIdentity(ud).memberNumber).toBeNull()
    const assigned = assignMemberNumber(1284, ud)
    expect(assigned.memberNumber).toBe(1284)
    expect(memberNumberLabel(assigned.memberNumber)).toBe('1284')
    writeInstallIdentity({ memberNumber: null }, ud)
    expect(readInstallIdentity(ud).memberNumber).toBe(1284)
    assignMemberNumber(-3, ud)
    expect(readInstallIdentity(ud).memberNumber).toBe(1284)
  })

  it('reuses the same install UUID across reads', () => {
    const a = readInstallIdentity(ud)
    const b = readInstallIdentity(ud)
    expect(b.installId).toBe(a.installId)
  })
})
