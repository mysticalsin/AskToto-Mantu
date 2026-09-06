import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { brainConnectSettingsPatch, normalizeConnectPath } from '@shared/mantu-intelligence'
import { scanOneDriveBrains } from './onedrive-scan'

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mantu-intel-scan-'))
  temps.push(dir)
  return dir
}

describe('OneDrive scan (fs)', () => {
  it('finds the preferred Mantu AI Second Brain and wiki/.brain/LLM markers', () => {
    const home = tmp()
    const mantu = join(home, 'Library', 'CloudStorage', 'OneDrive-MantuGroup')
    const preferred = join(mantu, 'Documents', 'AI Second Brain')
    const other = join(home, 'Library', 'CloudStorage', 'OneDrive-Personal', 'Documents', 'Notes')
    mkdirSync(join(preferred, 'wiki'), { recursive: true })
    mkdirSync(join(preferred, '.brain'), { recursive: true })
    writeFileSync(join(preferred, 'llms.txt'), 'wiki index', 'utf8')
    mkdirSync(join(other, 'wiki'), { recursive: true })

    const result = scanOneDriveBrains({
      platform: 'darwin',
      homedir: home,
      env: {},
      configuredFolder: ''
    })

    expect(result.scannedRoots).toContain(mantu)
    expect(result.hits[0].path).toBe(preferred)
    expect(result.hits[0].preferred).toBe(true)
    expect(result.hits[0].markers).toEqual(expect.arrayContaining(['.brain', 'wiki', 'llms.txt']))
    expect(result.hits.some((h) => h.path === other)).toBe(true)
  })

  it('marks the configured meetings root as connected so Connect sticks across relaunch reads', () => {
    const home = tmp()
    const root = join(home, 'Library', 'CloudStorage', 'OneDrive-MantuGroup')
    const brain = join(root, 'Documents', 'AI Second Brain')
    mkdirSync(join(brain, '.brain'), { recursive: true })

    const result = scanOneDriveBrains({
      platform: 'darwin',
      homedir: home,
      env: {},
      configuredFolder: brain
    })
    const hit = result.hits.find((h) => h.path === brain)
    expect(hit?.connected).toBe(true)
    expect(result.connectedPath).toBe(brain)
    expect(brainConnectSettingsPatch(brain)).toEqual({ meetingsFolder: brain })
    expect(normalizeConnectPath(brain).ok).toBe(true)
  })

  it('scans Windows OneDrive env roots for the same markers', () => {
    const home = tmp()
    const commercial = join(home, 'OneDrive - Mantu Group')
    const brain = join(commercial, 'Documents', 'AI Second Brain')
    mkdirSync(join(brain, 'wiki'), { recursive: true })
    writeFileSync(join(brain, 'CLAUDE.md'), '# second brain', 'utf8')

    const result = scanOneDriveBrains({
      platform: 'win32',
      homedir: home,
      env: { OneDriveCommercial: commercial }
    })
    expect(result.hits.some((h) => h.path === brain && h.preferred)).toBe(true)
  })
})
