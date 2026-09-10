import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { INTELLIGENCE_PASS_AUTO_START } from '@shared/intelligence-pass'

const brainView = readFileSync(resolve(__dirname, 'BrainView.tsx'), 'utf8')
const recallView = readFileSync(resolve(__dirname, 'RecallView.tsx'), 'utf8')

describe('BrainView Intelligence Update wiring', () => {
  it('shows the Update Intelligence button and starts the pass on click', () => {
    expect(brainView).toContain('IntelligenceUpdateButton')
    expect(brainView).toContain('startIntelligenceUpdateFromClick')
    expect(brainView).toContain('brainIntelligencePass')
    expect(brainView).toMatch(/onClick=\{\(\) => void runIntelligencePass\(\)\}/)
  })

  it('does not auto-start this pass on mount or from the backlog gate', () => {
    expect(INTELLIGENCE_PASS_AUTO_START).toBe(false)
    expect(brainView).toMatch(/shouldAutoBackfill/)
    expect(brainView).not.toMatch(/shouldAutoBackfill[\s\S]{0,400}brainIntelligencePass/)
    expect(brainView).not.toMatch(/useEffect\([\s\S]{0,200}runIntelligencePass/)
    expect(brainView).not.toMatch(/useEffect\([\s\S]{0,200}brainIntelligencePass/)
  })

  it('never auto-sends from this pass', () => {
    expect(brainView).not.toMatch(/brainIntelligencePass[\s\S]{0,400}mcpPush/)
    expect(brainView).not.toMatch(/runIntelligencePass[\s\S]{0,400}mcpPush/)
    expect(brainView).not.toMatch(/sendMail|autoSend/)
  })

  it('shows an indeterminate finishing phase while recap or publication still owns the pass', () => {
    expect(brainView).toContain('ingested === 0 && !statusWorking && !backfilling')
    expect(brainView).toMatch(/status\?\.intelligenceIndex\?\.running \? \(/)
    expect(brainView).toContain('Finishing Intelligence update…')
    expect(brainView).toMatch(/ariaLabel="Mantu Intelligence completion progress"[\s\S]{0,150}percent=\{null\}/)
  })

  it('uses the tested coalesced refresh rather than swallowing a rejected post-click read', () => {
    expect(brainView).toContain('createBrainRefresh(')
    expect(brainView).not.toContain('refreshingRef')
    expect(brainView).toContain('setStatusError(INTELLIGENCE_STATUS_UNAVAILABLE)')
  })

  it('separates Recall transport failures from action failures and clears recovered idle status', () => {
    const applyStatus = recallView.match(/const applyStatus = [\s\S]*?\n  }/)?.[0]
    expect(applyStatus).toContain('setStatusError(st ? null : INTELLIGENCE_STATUS_UNAVAILABLE)')
    expect(applyStatus).toContain('if (st?.intelligenceIndex?.running) setError(null)')
    expect(recallView).toContain('error || statusError || brainStatusError(brain)')
    expect(recallView).toContain('.catch(() => setStatusError(INTELLIGENCE_STATUS_UNAVAILABLE))')
  })
})
