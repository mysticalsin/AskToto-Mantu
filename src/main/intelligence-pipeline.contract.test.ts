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

  it('nulls the hidden-window singleton before destroy so the next decode is not already-active', () => {
    const start = indexSrc.indexOf('async function closeImportDecoder')
    expect(start).toBeGreaterThan(-1)
    const body = indexSrc.slice(start, indexSrc.indexOf('function bundledImportFfmpeg'))
    expect(body).toMatch(/decoderWin = null/)
    expect(body).toMatch(/decoderJobId = null/)
    expect(body.indexOf('decoderWin = null')).toBeLessThan(body.indexOf('win.destroy()'))
    expect(indexSrc).toMatch(/decoderSlotIsStale\(staleState\)/)
  })

  it('brain:backfill returns the sign-in copy instead of throwing, so the button cannot look dead', () => {
    const start = indexSrc.indexOf('ipcMain.handle(IPC.brainBackfill')
    expect(start).toBeGreaterThan(-1)
    const body = indexSrc.slice(start, start + 500)
    expect(body).toMatch(/SIGN_IN_INDEX_COPY/)
    expect(body).not.toMatch(/throw new Error\('Sign in with your Mantu account first\.'\)/)
    expect(body).toMatch(/runIntelligenceIndex\('click'\)/)
  })
})

describe('import idle may start one Intelligence pass', () => {
  it('onIdle kicks runIntelligenceIndex once and BrainView has no repeating index timer', () => {
    expect(indexSrc).toMatch(/runIntelligenceIndex\('import-idle'\)/)
    expect(indexSrc).toMatch(/scheduleIntelligenceIndex\(trackTimer\)/)
    expect(indexSrc).toMatch(/catchUpIntelligenceIndexIfNeeded/)
    expect(brainView).toMatch(/shouldAutoBackfill/)
    expect(brainView).toMatch(/IntelligenceUpdateButton/)
    expect(brainView).toMatch(/runIntelligenceUpdateClick/)
    expect(brainView).not.toMatch(/setInterval\(\(\) => void startBackfill/)
    expect(brainView).not.toMatch(/setInterval\(\(\) => \{\s*void startBackfill/)
  })
})
