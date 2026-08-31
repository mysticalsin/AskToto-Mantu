import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const brainView = readFileSync(join(__dirname, '../renderer/src/components/BrainView.tsx'), 'utf8')

describe('hidden-window decoder stays a live singleton', () => {
  it('throws already-active when Listen is live or another decoder window exists', () => {
    const start = indexSrc.indexOf('if (listeningActive) throw new Error')
    expect(start).toBeGreaterThan(-1)
    const body = indexSrc.slice(start, start + 400)
    expect(body).toMatch(/if \(listeningActive\) throw new Error\('Another audio decoder is already active\.'\)/)
    expect(body).toMatch(
      /if \(decoderWin && !decoderWin\.isDestroyed\(\)\) throw new Error\('Another audio decoder is already active\.'\)/
    )
  })

  it('releases the decode slot when the hidden window completes or fails', () => {
    expect(indexSrc).toMatch(/await importJobs\.releaseDecodeSlot\(parsed\.jobId\)/)
    expect(indexSrc).toMatch(/ffmpegDecoders\.delete\(job\.jobId\)/)
  })
})

describe('import idle may start one Intelligence pass', () => {
  it('onIdle kicks runIntelligenceIndex once and BrainView has no repeating index timer', () => {
    expect(indexSrc).toMatch(/runIntelligenceIndex\('import-idle'\)/)
    expect(indexSrc).toMatch(/scheduleIntelligenceIndex\(trackTimer\)/)
    expect(indexSrc).toMatch(/catchUpIntelligenceIndexIfNeeded/)
    expect(brainView).toMatch(/shouldAutoBackfill/)
    expect(brainView).not.toMatch(/setInterval\(\(\) => void startBackfill/)
    expect(brainView).not.toMatch(/setInterval\(\(\) => \{\s*void startBackfill/)
  })
})
