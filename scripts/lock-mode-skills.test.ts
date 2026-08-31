import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONVERSATION_MODES } from '../src/shared/ipc'
import { buildLock, composeLockedAppendix, diffLock, LOCK_PATH, readLock } from './lock-mode-skills.mjs'

describe('lock-mode-skills', () => {
  it('the committed lock matches the skill files on disk', () => {
    const current = buildLock()
    const expected = readLock()
    expect(diffLock(current, expected)).toEqual([])
    expect(Object.keys(current.skills).sort()).toEqual(['humanizer', ...CONVERSATION_MODES].sort())
  })

  it('electron-builder copies the skills tree as extraResources', () => {
    const yml = readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')
    expect(yml).toMatch(/from: skills/)
    expect(yml).toMatch(/to: skills/)
  })

  it('composeLockedAppendix for general matches the TS markers', () => {
    const appendix = composeLockedAppendix('general')
    expect(appendix).toContain('--- LOCKED MODE SKILL (general v')
    expect(appendix).toContain('--- END LOCKED MODE SKILL ---')
    expect(appendix).toContain('--- LOCKED HUMANIZER (v')
    expect(appendix).toContain('--- END LOCKED HUMANIZER ---')
    const custom = composeLockedAppendix(null)
    expect(custom).not.toContain('LOCKED MODE SKILL')
    expect(custom).toContain('LOCKED HUMANIZER')
  })

  it('the lock file is schemaVersion 1 sha256', () => {
    const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'))
    expect(lock.schemaVersion).toBe(1)
    expect(lock.algorithm).toBe('sha256')
    expect(lock.skills.recruiting.version).toBe('1.1.0')
    expect(lock.skills.humanizer.sha256).toMatch(/^[a-f0-9]{64}$/)
  })
})
