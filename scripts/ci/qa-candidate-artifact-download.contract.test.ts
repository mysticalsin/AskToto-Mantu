import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(join(__dirname, '../../.github/workflows/qa-candidate.yml'), 'utf8')

describe('candidate artifact downloads reject an interrupted stream [M2-0538]', () => {
  it('pins every download to the version with the direct timeout rejection', () => {
    // Artifact 4.0.0 rejects the download promise when its idle timer destroys the stream.
    const fixedAction = '018cc2cf5baa6db3ef3c5f8a56943fffe632ef53'
    const downloads = [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s+actions\/download-artifact@(\S+)/gm)]
    expect(downloads.length).toBeGreaterThan(0)
    for (const download of downloads) expect(download[1]).toBe(fixedAction)
  })
})
