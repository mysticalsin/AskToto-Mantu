import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SUGGEST_TRANSCRIPT_TAIL_CHARS } from '@shared/transcript-tail'

const mainSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8').replace(/\r\n/g, '\n')
const appSrc = readFileSync(join(__dirname, '..', 'renderer', 'src', 'App.tsx'), 'utf8').replace(/\r\n/g, '\n')
const sharedSrc = readFileSync(join(__dirname, 'llm', 'shared.ts'), 'utf8').replace(/\r\n/g, '\n')

// The spoken suggest line reads a bounded transcript tail (llm/shared.ts). Everything upstream of that
// read used to carry the whole meeting: the renderer built and shipped it every suggest tick, main
// zod-parsed it and ran ~20 redaction regex passes over it, then buildBrainContext NFKD-normalized it
// and scanned every entity key against it. All of that sat before the first byte left the machine.
describe('suggest transcript tail (pre-dispatch latency)', () => {
  it('the renderer sends only the tail on every suggest run', () => {
    const suggestRuns = appSrc.match(/\.run\(\{ mode: 'suggest', transcript: listen\.text\(\)[^}]*\}\)/g) ?? []
    for (const run of suggestRuns) expect(run).toContain('.slice(-SUGGEST_TRANSCRIPT_TAIL_CHARS)')
    expect(suggestRuns.length).toBeGreaterThanOrEqual(2)
    expect(appSrc).toMatch(/const transcript = listen\.text\(\)\.slice\(-SUGGEST_TRANSCRIPT_TAIL_CHARS\)/)
  })

  it('the tail covers what the suggest prompt reads', () => {
    const read = /\(req\.transcript \|\| ''\)\.slice\(-(\d+)\)/.exec(sharedSrc)
    expect(read).not.toBeNull()
    expect(SUGGEST_TRANSCRIPT_TAIL_CHARS).toBeGreaterThanOrEqual(Number(read![1]))
  })

  it('main clips a suggest transcript before redaction, and only for suggest', () => {
    const clip = mainSrc.indexOf("if (req.mode === 'suggest' && req.transcript && req.transcript.length > SUGGEST_TRANSCRIPT_TAIL)")
    const redact = mainSrc.indexOf('if (s.redactSensitive && req.transcript) req.transcript = redactSecrets(req.transcript)')
    expect(clip).toBeGreaterThan(-1)
    expect(redact).toBeGreaterThan(clip)
  })

  it('brain context matches against the question plus a bounded transcript tail', () => {
    expect(mainSrc).toMatch(
      /buildBrainContext\(s, `\$\{req\.prompt\}\\n\$\{\(req\.transcript \?\? ''\)\.slice\(-BRAIN_CONTEXT_TRANSCRIPT_TAIL\)\}`\)/
    )
    expect(mainSrc).toMatch(/const BRAIN_CONTEXT_TRANSCRIPT_TAIL = \d+/)
  })
})
