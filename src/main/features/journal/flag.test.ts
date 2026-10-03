import { afterEach, describe, expect, it, vi } from 'vitest'
import { app } from 'electron'
import { journalEnabled } from './flag'

vi.mock('electron')

describe('journal flag', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    delete (app as { isPackaged?: boolean }).isPackaged
  })

  it('is off by default', () => {
    vi.stubEnv('ASKTOTO_FLAG_JOURNAL', '')
    expect(journalEnabled()).toBe(false)
  })

  it('turns on in a development build with ASKTOTO_FLAG_JOURNAL=1', () => {
    vi.stubEnv('ASKTOTO_FLAG_JOURNAL', '1')
    expect(journalEnabled()).toBe(true)
  })

  it('ignores the variable in a packaged build', () => {
    vi.stubEnv('ASKTOTO_FLAG_JOURNAL', '1')
    ;(app as { isPackaged?: boolean }).isPackaged = true
    expect(journalEnabled()).toBe(false)
  })
})
