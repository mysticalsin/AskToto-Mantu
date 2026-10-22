import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { selectLeanInstallers } from './lean-installer-selection.mjs'

describe('lean installer selection (G11)', () => {
  it('measures the Windows Setup only, so building the Portable beside it does not fail the measurement', () => {
    const paths = [
      join('release', 'lean-win-x64', 'Metis-Setup-2.12.0.exe'),
      join('release', 'lean-win-x64', 'Metis-Portable-2.12.0.exe'),
      join('release', 'lean-win-x64', 'win-unpacked', 'Metis.exe')
    ]
    expect(selectLeanInstallers(paths, 'win')).toEqual([paths[0]])
  })

  it('measures the macOS DMG only, never the update zip', () => {
    const paths = [join('out', 'Metis-2.12.0-arm64.dmg'), join('out', 'Metis-2.12.0-arm64.zip')]
    expect(selectLeanInstallers(paths, 'mac')).toEqual([paths[0]])
  })

  it('is what the measurement script uses', () => {
    const script = readFileSync(join(__dirname, '..', 'measure-lean-candidate.mjs'), 'utf8')
    expect(script).toMatch(/from '\.\/lib\/lean-installer-selection\.mjs'/)
  })
})
