import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Source contracts for two fixes from the 178-agent deep audit (2026-08-10, docs/qa/BUG-LEDGER.md). Both
 * live in large closures / IPC-handler blocks with no injectable seam, so — like the other *.contract.test.ts
 * beside them — the fix is pinned against source text.
 */
const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const appSrc = readFileSync(join(__dirname, '..', 'renderer', 'src', 'App.tsx'), 'utf8')

describe('MQA-129 — team-transcript-folder IPC handlers require auth', () => {
  it('both add/remove handlers gate on requireAuth() like every other settings-writing handler', () => {
    // These mutate settings.teamTranscriptFolders — adding a folder to the brain's ingestion set — so an
    // unauthenticated caller must not reach them.
    const add = indexSrc.slice(indexSrc.indexOf('IPC.addTeamTranscriptFolder'), indexSrc.indexOf('IPC.removeTeamTranscriptFolder'))
    const remove = indexSrc.slice(indexSrc.indexOf('IPC.removeTeamTranscriptFolder'), indexSrc.indexOf('IPC.openPath'))
    expect(add).toMatch(/if \(!requireAuth\(\)\) return publicSettings\(\)/)
    expect(remove).toMatch(/if \(!requireAuth\(\)\) return publicSettings\(\)/)
  })
})

describe('MQA-130 — Local AI fallback readiness is honored in the renderer gates', () => {
  it('requireProvider() lists localFallbackReady in its dependency array (no stale gate)', () => {
    // Sliced to the useCallback's own closing `  )` rather than a fixed character count — a fixed window
    // silently stops covering the dependency array the moment the body grows (which is exactly what
    // happened when the gate learned about the answer floor, MQA-242).
    const rest = appSrc.slice(appSrc.indexOf('const requireProvider'))
    const end = rest.search(/\n {2}\)\r?\n/)
    expect(end, 'requireProvider useCallback closing paren not found').toBeGreaterThan(-1)
    const block = rest.slice(0, end)
    expect(block).toMatch(/settings\?\.localFallbackReady,/)
  })

  it("the Summarize screen-eligibility check includes localFallbackReady, matching requireProvider('vision')", () => {
    // Anchored on the fix's unique expression: the other canUseScreen sites use settings.visionAvailable, so
    // this localVisionReady || localFallbackReady pair appears only at the Summarize gate that was fixed.
    expect(appSrc).toMatch(/settings\?\.localVisionReady \|\| settings\?\.localFallbackReady/)
  })
})
