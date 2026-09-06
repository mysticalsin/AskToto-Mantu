import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { INTELLIGENCE_PASS_AUTO_START } from '@shared/intelligence-pass'

const brainView = readFileSync(resolve(__dirname, 'BrainView.tsx'), 'utf8')

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
})
