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

  it('contains a rejected pass IPC without exposing its raw diagnostic or automatically retrying', async () => {
    const runPass = vi.fn().mockRejectedValue(new Error('private/path/provider-payload'))
    const refresh = vi.fn(async () => {})
    const setError = vi.fn()
    const error = 'Could not confirm the Intelligence update. Check its status before trying again.'
    await expect(startIntelligenceUpdateFromClick({ runPass, refresh, setError })).resolves.toEqual({ queued: 0, error })
    expect(setError).toHaveBeenLastCalledWith(error)
    expect(runPass).toHaveBeenCalledTimes(1)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('keeps dispatch evidence when only the following refresh fails', async () => {
    const runPass = vi.fn(async () => ({ queued: 2, preparing: true }))
    const refresh = vi.fn().mockRejectedValue(new Error('private/path/status-error'))
    const setError = vi.fn()
    const error = 'The Intelligence update may still be running. Could not refresh its status; reopen Intelligence to check.'
    await expect(startIntelligenceUpdateFromClick({ runPass, refresh, setError })).resolves.toEqual({ queued: 2, preparing: true, error })
    expect(setError).toHaveBeenLastCalledWith(error)
    expect(runPass).toHaveBeenCalledTimes(1)
  })

  it('observes the safe failed outcome returned by a contained dashboard refresh', async () => {
    const runPass = vi.fn(async () => ({ queued: 2 }))
    const refresh = vi.fn(async () => ({ ok: false }))
    const setError = vi.fn()
    const result = await startIntelligenceUpdateFromClick({ runPass, refresh, setError })
    expect(result.error).toBe('The Intelligence update may still be running. Could not refresh its status; reopen Intelligence to check.')
    expect(result.queued).toBe(2)
    expect(setError).toHaveBeenLastCalledWith(result.error)
  })

  it('never auto-sends from this click helper', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('./intelligence-pass.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/\bmcpPush\b|\bsendMail\b|\bautoSend\b/)
    expect(src).not.toMatch(/useEffect/)
  })
})
