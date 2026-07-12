import { describe, it, expect } from 'vitest'
import { decideDustLiveCheck } from './dust-live-check'

describe('decideDustLiveCheck', () => {
  it('treats a successful probe as connected — no re-setup', () => {
    expect(decideDustLiveCheck({ ok: true })).toBe('connected')
    // accessDenied is ignored once ok is true (can't happen in practice, but ok wins).
    expect(decideDustLiveCheck({ ok: true, accessDenied: true })).toBe('connected')
  })

  it('routes a blocked keychain read to needs-access, NOT a setup relaunch', () => {
    expect(decideDustLiveCheck({ ok: false, accessDenied: true })).toBe('needs-access')
  })

  it('auto-runs setup when the saved connection has no live session behind it', () => {
    expect(decideDustLiveCheck({ ok: false, accessDenied: false })).toBe('run-setup')
    // Missing accessDenied (undefined) is a genuine "no session", not an access denial.
    expect(decideDustLiveCheck({ ok: false })).toBe('run-setup')
  })

  it('routes an incomplete session (token but no workspace pick) to finish-workspace-pick, NOT a setup relaunch', () => {
    expect(decideDustLiveCheck({ ok: false, incomplete: true })).toBe('finish-workspace-pick')
  })

  it('accessDenied still wins over incomplete — a blocked keychain read cannot know if it is incomplete', () => {
    expect(decideDustLiveCheck({ ok: false, accessDenied: true, incomplete: true })).toBe('needs-access')
  })
})
