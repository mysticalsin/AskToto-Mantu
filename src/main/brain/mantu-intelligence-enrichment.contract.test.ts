import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * G Mantu Intelligence enrichment reuses the existing Intelligence index.
 * Connect only persists meetingsFolder. No second index file or cadence.
 */
const indexSrc = readFileSync(join(__dirname, 'intelligence-index.ts'), 'utf8')
const mainSrc = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8')
const scanSrc = readFileSync(join(__dirname, 'onedrive-scan.ts'), 'utf8')
const sharedSrc = readFileSync(join(__dirname, '../../shared/mantu-intelligence.ts'), 'utf8')

describe('Mantu Intelligence enrichment stays on INTELLIGENCE-UPDATE', () => {
  it('named slots stay 06:00 / 12:00 / 18:00 America/Toronto', () => {
    expect(indexSrc).toMatch(/INTELLIGENCE_INDEX_HOURS = \[6, 12, 18\]/)
    expect(indexSrc).toMatch(/America\/Toronto/)
  })

  it('connect persists meetingsFolder only', () => {
    expect(sharedSrc).toMatch(/return \{ meetingsFolder: path \}/)
    const connect = mainSrc.slice(mainSrc.indexOf('IPC.brainConnect'), mainSrc.indexOf('IPC.brainConnect') + 1800)
    expect(connect).toMatch(/setSettings\(brainConnectSettingsPatch\(normalized\.path\)\)/)
    expect(connect).not.toMatch(/intelligence-connections\.json|second-index|mantu-index/)
  })

  it('scan does not write a second brain index', () => {
    expect(scanSrc).not.toMatch(/writeFileSync|writeFile\(/)
    expect(scanSrc).toMatch(/scanOneDriveBrains/)
  })
})
