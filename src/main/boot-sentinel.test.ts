import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beginBootWatch, endBootWatch } from './boot-sentinel'
import { beginBrainResumeWatch, describeBrainResumeDeath, endBrainResumeWatch, readBrainResumeDeath } from './brain-resume-watch'

describe('M2-0038 — boot sentinel and delayed brain-resume marker are separate', () => {
  let userData: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'asktoto-m2-0038-'))
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  it('clearing the early boot sentinel does not clear the delayed brain-resume marker', () => {
    expect(beginBootWatch(userData, '2.0.0', () => '2026-09-30T10:00:00.000Z')).toBeNull()
    expect(beginBrainResumeWatch(userData, '2.0.0', () => '2026-09-30T10:00:15.000Z')).toBeNull()

    endBootWatch(userData)

    expect(existsSync(join(userData, 'boot-incomplete.json'))).toBe(false)
    expect(existsSync(join(userData, 'brain-resume-incomplete.json'))).toBe(true)

    endBrainResumeWatch(userData)
    expect(existsSync(join(userData, 'brain-resume-incomplete.json'))).toBe(false)
  })

  it('a native death inside the brain-resume step is reported on the next launch', () => {
    expect(beginBrainResumeWatch(userData, '2.0.0', () => '2026-09-30T10:00:15.000Z')).toBeNull()
    const marker = JSON.parse(readFileSync(join(userData, 'brain-resume-incomplete.json'), 'utf8'))
    expect(marker).toMatchObject({ version: '2.0.0', consecutive: 0 })

    const death = beginBrainResumeWatch(userData, '2.0.1', () => '2026-09-30T10:01:15.000Z')
    expect(death).not.toBeNull()
    expect(death).toMatchObject({
      startedAt: '2026-09-30T10:00:15.000Z',
      version: '2.0.0',
      consecutive: 1
    })
    expect(describeBrainResumeDeath(death!)).toContain('died during brain resume')
  })

  it('an injected brain-resume marker is enough to trigger safe-start evidence without a boot sentinel', () => {
    mkdirSync(userData, { recursive: true })
    writeFileSync(
      join(userData, 'brain-resume-incomplete.json'),
      JSON.stringify({ startedAt: '2026-09-30T10:00:15.000Z', pid: 123, version: '2.0.0', consecutive: 0 }),
      'utf8'
    )

    expect(existsSync(join(userData, 'boot-incomplete.json'))).toBe(false)
    const death = beginBrainResumeWatch(userData, '2.0.1', () => '2026-09-30T10:01:15.000Z')

    expect(death).toMatchObject({
      pid: 123,
      version: '2.0.0',
      consecutive: 1
    })
  })

  it('readBrainResumeDeath reports an injected marker without clearing it', () => {
    const marker = join(userData, 'brain-resume-incomplete.json')
    mkdirSync(userData, { recursive: true })
    writeFileSync(
      marker,
      JSON.stringify({ startedAt: '2026-09-30T10:00:15.000Z', pid: 123, version: '2.0.0', consecutive: 0 }),
      'utf8'
    )

    const death = readBrainResumeDeath(userData)

    expect(death).toMatchObject({
      startedAt: '2026-09-30T10:00:15.000Z',
      pid: 123,
      version: '2.0.0',
      consecutive: 1
    })
    expect(existsSync(marker)).toBe(true)
  })
})
