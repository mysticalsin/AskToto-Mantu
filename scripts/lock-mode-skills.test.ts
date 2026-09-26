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
    expect(Object.keys(current.skills).sort()).toEqual(['caveman', 'humanizer', ...CONVERSATION_MODES].sort())
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

  it('CRLF on disk hashes the same as the committed LF lock', () => {
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs') as typeof import('node:fs')
    const { tmpdir } = require('node:os') as typeof import('node:os')
    const { join } = require('node:path') as typeof import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'skill-crlf-'))
    try {
      for (const rel of ['humanizer/SKILL.md', 'caveman/SKILL.md', ...['interview','recruiting','meeting','sales','negotiation','presentation','support','general','cold-call'].map((id) => `modes/${id}/SKILL.md`)]) {
        const src = join(process.cwd(), 'skills', rel)
        const dest = join(dir, rel)
        mkdirSync(join(dest, '..'), { recursive: true })
        writeFileSync(dest, readFileSync(src, 'utf8').replace(/\n/g, '\r\n'))
      }
      const { buildLock } = require('./lock-mode-skills.mjs') as typeof import('./lock-mode-skills.mjs')
      expect(diffLock(buildLock(dir), readLock())).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the lock file is schemaVersion 1 sha256', () => {
    const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'))
    expect(lock.schemaVersion).toBe(1)
    expect(lock.algorithm).toBe('sha256')
    expect(lock.skills.recruiting.version).toBe('1.1.0')
    expect(lock.skills.humanizer.sha256).toMatch(/^[a-f0-9]{64}$/)
  })
})
