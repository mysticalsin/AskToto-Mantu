import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * MQA-252 — the Dust session logic, tested on every platform.
 *
 * dustcli.test.ts drives the REAL macOS login keychain, which is the right way to prove Métis reads the
 * session `dust login` actually wrote — and which means all six of its tests skip on Windows and Linux.
 * Six skips is six untested paths reporting as green, and the branch decisions in importDustCliSession
 * (which error the user sees, whether a half-finished login is distinguishable from no login at all,
 * which API host an EU workspace gets) have nothing to do with macOS. They were simply unreachable
 * because they sat behind a real keychain call.
 *
 * readDustSecret lives in its own module, so mocking it makes every one of those decisions testable
 * everywhere. This does NOT replace the keychain suite — that one proves the real read works, this one
 * proves the logic around it is right. Neither is sufficient alone, and only one of them can run here.
 */
const store = vi.hoisted(() => ({
  reads: new Map<string, { value: string | null; accessDenied?: boolean }>()
}))

vi.mock('./dust-secret-store', () => ({
  DUST_KEYCHAIN_SERVICE: 'dust-cli',
  readDustSecret: vi.fn(async (account: string) => store.reads.get(account) ?? { value: null }),
  readDustSessionSecrets: vi.fn(async () => {
    const field = (account: string) => store.reads.get(account) ?? { value: null, accessDenied: false }
    return {
      access_token: field('access_token'),
      workspace_sid: field('workspace_sid'),
      region: field('region'),
      privilegeSpawns: 1
    }
  })
}))
vi.mock('./cli', () => ({
  killWindowsProcessTree: vi.fn(),
  resolveBin: vi.fn(async () => null),
  resolveSpawnTarget: vi.fn(() => null)
}))

import { importDustCliSession } from './dustcli'

/** Seed the fake keychain exactly as `dust login` would leave it. */
function seed(entries: Record<string, string | null | { accessDenied: true }>): void {
  store.reads.clear()
  for (const [k, v] of Object.entries(entries)) {
    store.reads.set(k, typeof v === 'object' && v !== null ? { value: null, accessDenied: true } : { value: v as string | null })
  }
}

describe('MQA-252 — importDustCliSession decisions, on every platform', () => {
  beforeEach(() => store.reads.clear())

  it('reports no session when the keychain is empty — not an error, a not-signed-in', () => {
    seed({})
    return importDustCliSession().then((r) => {
      expect(r.ok).toBe(false)
      expect(r.incomplete ?? false).toBe(false) // an empty keychain is NOT a half-finished login
      expect(r.error).toMatch(/No Dust CLI session found/)
    })
  })

  it('maps an EU region to eu.dust.tt', async () => {
    seed({ access_token: 't', workspace_sid: 'w', region: 'europe-west1' })
    const r = await importDustCliSession()
    expect(r.ok).toBe(true)
    expect(r.baseUrl).toBe('https://eu.dust.tt')
    expect(r.workspaceId).toBe('w')
  })

  it('maps everything else to dust.tt, including an absent region', async () => {
    for (const region of ['us-central1', 'anything', null]) {
      seed({ access_token: 't', workspace_sid: 'w', region })
      expect((await importDustCliSession()).baseUrl).toBe('https://dust.tt')
    }
  })

  it('a token with no workspace is INCOMPLETE, not a plain failure', async () => {
    // The browser half of `dust login` finished and the terminal workspace-picker did not. Telling the
    // user to reinstall would send them past an already-open terminal that just needs one more answer.
    seed({ access_token: 't', workspace_sid: null })
    const r = await importDustCliSession()
    expect(r.ok).toBe(false)
    expect(r.incomplete).toBe(true)
    expect(r.error).toMatch(/Finish picking your workspace/)
  })

  it('a genuinely empty keychain is never flagged incomplete', async () => {
    // The distinction the previous test relies on: "incomplete" must mean something, so it must not fire
    // for the ordinary not-signed-in case.
    seed({ access_token: null, workspace_sid: null })
    expect((await importDustCliSession()).incomplete ?? false).toBe(false)
  })

  it('a Keychain denial is reported as a denial, per secret, never as "no session"', async () => {
    // These are opposite remedies: one is "grant access", the other is "sign in". Conflating them sends
    // the user to re-run a login they have already completed.
    for (const denied of ['access_token', 'workspace_sid', 'region']) {
      seed({ access_token: 't', workspace_sid: 'w', region: 'us', [denied]: { accessDenied: true } })
      const r = await importDustCliSession()
      expect(r.ok, `${denied} denial should not succeed`).toBe(false)
      expect(r.accessDenied, `${denied} denial should be flagged`).toBe(true)
      expect(r.error).toMatch(/Keychain/)
    }
  })

  it('does not leak the token into the renderer-facing failure shapes', async () => {
    seed({ access_token: 'secret-token', workspace_sid: null })
    const r = await importDustCliSession()
    expect(JSON.stringify(r)).not.toContain('secret-token')
  })
})
