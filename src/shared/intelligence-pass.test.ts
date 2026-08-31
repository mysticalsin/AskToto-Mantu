import { describe, expect, it, vi } from 'vitest'
import {
  INTELLIGENCE_PASS_AUTO_START,
  INTELLIGENCE_PASS_NO_PROVIDER,
  INTELLIGENCE_UPDATE_LABEL,
  startIntelligenceUpdateFromClick
} from './intelligence-pass'

describe('Intelligence Update contract', () => {
  it('never auto-starts this pass', () => {
    expect(INTELLIGENCE_PASS_AUTO_START).toBe(false)
  })

  it('keeps friendly Update copy, not lab-demo strings', () => {
    expect(INTELLIGENCE_UPDATE_LABEL).toBe('Update Intelligence')
    expect(INTELLIGENCE_UPDATE_LABEL).not.toMatch(/run agent|trigger pass|lab/i)
  })

  it('click starts the pass, then refreshes the dashboard', async () => {
    const runPass = vi.fn(async () => ({ queued: 2 }))
    const refresh = vi.fn(async () => {})
    const setError = vi.fn()
    await startIntelligenceUpdateFromClick({ runPass, refresh, setError })
    expect(runPass).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(setError).toHaveBeenCalledWith(null)
  })

  it('fails loud when Local and API are both missing', async () => {
    const runPass = vi.fn(async () => ({ queued: 0, error: INTELLIGENCE_PASS_NO_PROVIDER }))
    const refresh = vi.fn(async () => {})
    const setError = vi.fn()
    await startIntelligenceUpdateFromClick({ runPass, refresh, setError })
    expect(refresh).not.toHaveBeenCalled()
    expect(setError).toHaveBeenCalledWith(INTELLIGENCE_PASS_NO_PROVIDER)
  })

  it('never auto-sends from this click helper', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('./intelligence-pass.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/\bmcpPush\b|\bsendMail\b|\bautoSend\b/)
    expect(src).not.toMatch(/useEffect/)
  })
})
