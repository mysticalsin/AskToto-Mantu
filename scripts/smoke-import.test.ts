import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(__dirname, 'smoke-import.mjs'), 'utf8')

describe('import smoke isolation', () => {
  it('routes saved meetings into the temporary smoke profile before importing', () => {
    const configure = source.indexOf('window.toto.setSettings({ meetingsFolder:')
    const importStart = source.indexOf('window.toto.importAudioPick()')
    expect(configure).toBeGreaterThan(-1)
    expect(importStart).toBeGreaterThan(-1)
    expect(configure).toBeLessThan(importStart)
  })
})
