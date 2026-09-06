import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Source-contract lock for the imported-recording auto-summary path (runImportedRecap lives inside
// index.ts and has no unit seam — same rationale as the other *.contract.test.ts files).
//
// Regression pinned (found live 2026-08-04, importing a real Downloads recording): the recap streamed
// completely, then the provider stream ended with a trailing idle-timeout error (claude-cli lingers
// after its final token) and onError REJECTED — discarding the finished summary. Transcript saved,
// Notes empty, recapError set: exactly the user-reported "import doesn't auto-summarize".
const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8')

describe('imported-recording recap survives a trailing stream error', () => {
  const start = indexSrc.indexOf('async function runImportedRecap')
  const body = indexSrc.slice(start, indexSrc.indexOf('function initializeImportJobs'))

  it('onError keeps substantial already-streamed summary text instead of discarding it', () => {
    expect(start).toBeGreaterThan(-1)
    expect(body).toMatch(/if \(text\.trim\(\)\.length >= 200\) \{/)
    expect(body).toMatch(/resolveRecap\(text\)/)
  })

  it('early failures (no meaningful text) still reject into the provider waterfall', () => {
    expect(body).toMatch(/rejectRecap\(new Error\(error\)\)/)
  })

  it('recap failure still never fails the import job (invariant from import-jobs.ts)', () => {
    const jobsSrc = readFileSync(join(__dirname, 'import-jobs.ts'), 'utf8')
    expect(jobsSrc).toMatch(/recapError/)
  })
})

// Diarized import lines carry line.name ("Jane Doe" / "Speaker N"). The recap prompt asks the model to
// attribute by those labels — flattening every line to bare "SPEAKER:" erased attribution and made every
// import look like one anonymous talker.
describe('importedTranscriptText preserves diarization names for the recap prompt', () => {
  it('formats each line as `${line.name || SPEAKER}: text`, not a hard-coded SPEAKER label', () => {
    const start = indexSrc.indexOf('function importedTranscriptText')
    expect(start).toBeGreaterThan(-1)
    const body = indexSrc.slice(start, start + 500)
    expect(body).toMatch(/\$\{line\.name\?\.trim\(\) \|\| 'SPEAKER'\}: \$\{line\.text\}/)
    expect(body).not.toMatch(/`SPEAKER: \$\{line\.text\}`/)
  })
})

describe('ASR echo defense returns echo:true so the renderer can act (Parakeet / Apple / Whisper)', () => {
  it('parakeetFeed and appleSpeechFeed return { text: "", echo: true } on operator bleed', () => {
    expect(indexSrc).toMatch(/if \(label\?\.echo\) return \{ text: '', echo: true \}/)
  })

  it('speakerEmbed returns { echo: true } so Whisper can drop the already-committed THEM line', () => {
    const start = indexSrc.indexOf('ipcMain.handle(IPC.speakerEmbed')
    const body = indexSrc.slice(start, start + 1200)
    expect(body).toMatch(/if \(label\?\.echo\) return \{ echo: true/)
  })
})

describe('live ask keeps a substantial answer after a trailing stream error', () => {
  it('onError settles as streamDone when paintedLen >= 200 (parity with import-recap)', () => {
    expect(indexSrc).toMatch(/if \(gotToken && paintedLen >= 200\)/)
    expect(indexSrc).toMatch(/keeping \$\{paintedLen\}-char answer despite trailing stream error/)
    expect(indexSrc).toMatch(/IPC\.streamDone, \{ id: req\.id \}/)
  })
})

describe('brain status failedFiles excludes pending deferred ingest', () => {
  it('filters with isPendingIngestRecord so consolidation-queued meetings are not red "failed"', () => {
    expect(indexSrc).toMatch(/failedFiles: Object\.entries\(idx\.ingested\)/)
    expect(indexSrc).toMatch(/!v\.ok && !isPendingIngestRecord\(v\)/)
  })
})
