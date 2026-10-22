import { mkdir, mkdtemp, readdir, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const audit = vi.hoisted(() => ({ auditLog: vi.fn() }))
vi.mock('../../logger', () => ({ auditLog: audit.auditLog, mainLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { ORPHAN_TEMP_MIN_AGE_MS, sweepOrphanSavedTemps, type OrphanTempFs } from './orphan-temp-sweep'

const NOW = 1_800_000_000_000
const HEX12 = 'efcb20bf4ecb'
const HEX24 = '0123456789abcdef01234567'
const STALE = (NOW - ORPHAN_TEMP_MIN_AGE_MS - 60_000) / 1000
const FRESH = (NOW - 10_000) / 1000

let folder: string

async function put(name: string, ageSeconds: number = STALE): Promise<void> {
  await writeFile(join(folder, name), 'synthetic-bytes')
  await utimes(join(folder, name), ageSeconds, ageSeconds)
}

beforeEach(async () => {
  folder = await realpath(await mkdtemp(join(tmpdir(), 'metis-orphan-temp-')))
  audit.auditLog.mockClear()
})
afterEach(async () => {
  await rm(folder, { recursive: true, force: true })
})

describe('sweepOrphanSavedTemps', () => {
  it('removes stale atomic-write temps of both widths and reports counts', async () => {
    await put(`2026-10-22_000548-f234d45774f6.md.${HEX12}.tmp`)
    await put(`2026-10-22_000548-f234d45774f6.md.${HEX24}.tmp`)
    await put('2026-10-22_000548-f234d45774f6.md', STALE)
    const result = await sweepOrphanSavedTemps(folder, { now: NOW })
    expect(result).toEqual({ swept: 2, skipped: 0, failed: 0 })
    expect(await readdir(folder)).toEqual(['2026-10-22_000548-f234d45774f6.md'])
  })

  it('keeps a temp younger than the safety age', async () => {
    await put(`fresh.md.${HEX12}.tmp`, FRESH)
    const result = await sweepOrphanSavedTemps(folder, { now: NOW })
    expect(result).toEqual({ swept: 0, skipped: 1, failed: 0 })
    expect(await readdir(folder)).toEqual([`fresh.md.${HEX12}.tmp`])
  })

  it('never touches names that are not the exact atomic-write pattern', async () => {
    const keep = [
      'notes.md.tmp',
      `notes.md.${HEX12.toUpperCase()}.tmp`,
      `notes.md.${HEX12}0.tmp`,
      'notes.md.abcdef.tmp',
      `notes.txt.${HEX12}.tmp`,
      `index.json.${HEX12}.tmp`,
      `notes.md.${HEX12}.tmp.bak`,
      `.md.${HEX12}.tmp`,
      `.autosave-draft-2026-10-22_000548-123.md`,
      'settings.json.tmp',
      'plain.md'
    ]
    for (const name of keep) await put(name)
    const result = await sweepOrphanSavedTemps(folder, { now: NOW })
    expect(result.swept).toBe(0)
    expect((await readdir(folder)).sort()).toEqual([...keep].sort())
  })

  it('skips directories and does not recurse', async () => {
    await mkdir(join(folder, `dir.md.${HEX12}.tmp`))
    await mkdir(join(folder, 'sub'))
    await writeFile(join(folder, 'sub', `inner.md.${HEX12}.tmp`), 'synthetic-bytes')
    await utimes(join(folder, 'sub', `inner.md.${HEX12}.tmp`), STALE, STALE)
    const result = await sweepOrphanSavedTemps(folder, { now: NOW })
    expect(result.swept).toBe(0)
    expect(await readdir(join(folder, 'sub'))).toEqual([`inner.md.${HEX12}.tmp`])
    expect(await readdir(folder)).toContain(`dir.md.${HEX12}.tmp`)
  })

  it('never follows or removes a symlink wearing a temp name', async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'metis-orphan-outside-')))
    try {
      await writeFile(join(outside, 'target.txt'), 'synthetic-bytes')
      try {
        await symlink(join(outside, 'target.txt'), join(folder, `link.md.${HEX12}.tmp`))
      } catch {
        return // symlink creation needs privileges on some Windows hosts
      }
      const result = await sweepOrphanSavedTemps(folder, { now: NOW })
      expect(result.swept).toBe(0)
      expect(await readdir(folder)).toEqual([`link.md.${HEX12}.tmp`])
      expect(await readdir(outside)).toEqual(['target.txt'])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('returns zero counts for a missing folder and never rejects', async () => {
    const result = await sweepOrphanSavedTemps(join(folder, 'absent'), { now: NOW })
    expect(result).toEqual({ swept: 0, skipped: 0, failed: 0 })
    expect(audit.auditLog).not.toHaveBeenCalled()
  })

  it('tolerates EPERM and ENOENT on one temp and still sweeps the rest, using metadata only', async () => {
    const names = [`a.md.${HEX12}.tmp`, `b.md.${HEX12}.tmp`, `c.md.${HEX12}.tmp`]
    const removed: string[] = []
    // The injected port has no read call at all: the sweep cannot open file contents.
    const fs: OrphanTempFs = {
      readdir: async () => names,
      lstat: async () => ({
        isFile: () => true,
        isSymbolicLink: () => false,
        mtimeMs: STALE * 1000
      }),
      unlink: async (path: string) => {
        if (path.endsWith(`a.md.${HEX12}.tmp`)) throw Object.assign(new Error('locked'), { code: 'EPERM' })
        if (path.endsWith(`b.md.${HEX12}.tmp`)) throw Object.assign(new Error('gone'), { code: 'ENOENT' })
        removed.push(path)
      }
    }
    const result = await sweepOrphanSavedTemps(folder, { now: NOW, fs })
    expect(result).toEqual({ swept: 1, skipped: 1, failed: 1 })
    expect(removed).toEqual([join(folder, `c.md.${HEX12}.tmp`)])
  })

  it('audits one bounded event with counts only', async () => {
    await put(`secret-title.md.${HEX12}.tmp`)
    await put(`other-title.md.${HEX24}.tmp`, FRESH)
    await sweepOrphanSavedTemps(folder, { now: NOW })
    expect(audit.auditLog).toHaveBeenCalledTimes(1)
    expect(audit.auditLog).toHaveBeenCalledWith('transcript.temp_swept', { swept: 1, skipped: 1, failed: 0 })
    expect(JSON.stringify(audit.auditLog.mock.calls)).not.toContain('title')
  })
})
