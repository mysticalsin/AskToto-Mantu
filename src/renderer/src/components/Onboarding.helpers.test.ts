import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  apiPickerFallbackProvider,
  connectDust,
  providerReadyCopy,
  providerTileDisabledReason,
  ssoSignInVerdict
} from './Onboarding'
import { micRowStatus } from './OnboardingExperience'

describe('providerTileDisabledReason — step-5 provider tiles must not misreport why they are disabled', () => {
  it('is null (tappable) when nothing blocks the tile', () => {
    expect(providerTileDisabledReason({ providerLocked: false, pathAllowed: true })).toBeNull()
    expect(providerTileDisabledReason({ providerLocked: false, pathAllowed: true, busy: false })).toBeNull()
  })

  it('is "org" when provider is locked by managed config, regardless of busy', () => {
    expect(providerTileDisabledReason({ providerLocked: true, pathAllowed: true })).toBe('org')
    expect(providerTileDisabledReason({ providerLocked: true, pathAllowed: true, busy: true })).toBe('org')
  })

  it('is "org" when the org data-residency allowlist excludes this path, regardless of busy', () => {
    expect(providerTileDisabledReason({ providerLocked: false, pathAllowed: false })).toBe('org')
    expect(providerTileDisabledReason({ providerLocked: false, pathAllowed: false, busy: true })).toBe('org')
  })

  it('is "busy" only when nothing org-related blocks it AND busy is explicitly passed true', () => {
    expect(providerTileDisabledReason({ providerLocked: false, pathAllowed: true, busy: true })).toBe('busy')
  })

  it('never returns "busy" for a tile that does not pass busy at all — the CLI probe must not leak ' +
      'into the API-key or Mantu Dust tiles', () => {
    // The bug: cliBusy used to disable all three ProviderOption tiles, and the disabled badge always
    // said "Restricted by your organization" — so for ~45s the API-key and Dust tiles looked
    // org-restricted too. Callers for those tiles never pass `busy`, so this must stay null here.
    expect(providerTileDisabledReason({ providerLocked: false, pathAllowed: true })).toBeNull()
  })
})

describe('MQA-096 — step-5 "Something else … Pick it in Settings" must obey the org allowlist', () => {
  it('lands on the first APPROVED API-key provider, never the hard-coded anthropic', () => {
    // The bug: the link was onClick={() => choose('anthropic')}, so an org that approves only OpenAI
    // (+ Dust) finished onboarding on Anthropic — the one provider every ask then rejects.
    expect(apiPickerFallbackProvider(['openai', 'dust'])).toBe('openai')
    expect(apiPickerFallbackProvider(['openai', 'dust'])).not.toBe('anthropic')
    expect(apiPickerFallbackProvider(['nvidia'])).toBe('nvidia')
  })

  it('keeps anthropic when the org sets no allowlist at all (null = unrestricted)', () => {
    expect(apiPickerFallbackProvider(null)).toBe('anthropic')
    expect(apiPickerFallbackProvider(undefined)).toBe('anthropic')
  })

  it('is null when the allowlist approves no API-key provider, so the link can be hidden', () => {
    expect(apiPickerFallbackProvider(['dust'])).toBeNull()
    expect(apiPickerFallbackProvider([])).toBeNull()
  })
})

describe('MQA-094 — slide 1 must not read signIn()\'s unconfigured short-circuit as a sign-in', () => {
  it('classifies ok:true + configured:false as "not-configured", not success', () => {
    // main/auth.ts returns { ok: true, configured: false } when no Azure config resolves — no browser
    // opened, no session created. Advancing on it presented that no-op as a work-account sign-in.
    expect(ssoSignInVerdict({ ok: true, configured: false })).toBe('not-configured')
  })

  it('still treats a real sign-in as success (configured true or absent)', () => {
    expect(ssoSignInVerdict({ ok: true, configured: true, email: 'a@mantu.com' })).toBe('signed-in')
    expect(ssoSignInVerdict({ ok: true })).toBe('signed-in')
  })

  it('still reports a genuine failure as failed', () => {
    expect(ssoSignInVerdict({ ok: false, error: 'timed out' })).toBe('failed')
    expect(ssoSignInVerdict({ ok: false, configured: true })).toBe('failed')
  })
})

describe('MQA-067 — the Mantu Dust one-click path must leave step 6 reading a POST-import snapshot', () => {
  it('re-reads settings only after dustImportCli has resolved', async () => {
    const calls: string[] = []
    let resolveImport: (v: { ok: boolean }) => void = () => {}
    const pending = new Promise<{ ok: boolean }>((r) => {
      resolveImport = r
    })
    const run = connectDust({
      select: () => calls.push('select'),
      importCli: () => {
        calls.push('import')
        return pending
      },
      setupCli: () => calls.push('setup'),
      refreshSettings: async () => {
        calls.push('refresh')
      },
      stillLive: () => true
    })
    // The key writes land in MAIN during the import, so a refresh taken before it resolves is exactly
    // the stale snapshot the amber "add your key" row was built from.
    expect(calls).toEqual(['select', 'import'])
    resolveImport({ ok: true })
    await run
    expect(calls).toEqual(['select', 'import', 'refresh'])
  })

  it('falls back to the installer flow when the import finds no session, and still refreshes', async () => {
    const calls: string[] = []
    await connectDust({
      select: () => calls.push('select'),
      importCli: async () => {
        calls.push('import')
        return { ok: false, error: 'no session' }
      },
      setupCli: () => calls.push('setup'),
      refreshSettings: async () => {
        calls.push('refresh')
      },
      stillLive: () => true
    })
    expect(calls).toEqual(['select', 'import', 'setup', 'refresh'])
  })

  it('drops the refresh once onboarding moved on, so a late import cannot clobber a newer provider', async () => {
    const refreshSettings = vi.fn(async () => {})
    await connectDust({
      select: () => {},
      importCli: async () => ({ ok: true, workspaceId: 'w1' }),
      setupCli: () => {},
      refreshSettings,
      stillLive: () => false
    })
    expect(refreshSettings).not.toHaveBeenCalled()
  })

  it('tells a Dust user to finish the one-click sign-in instead of pasting a key', () => {
    // PROVIDERS.dust.kind is 'dust', which used to fall through to the generic API-key branch — the
    // readiness row then asked for a key this OAuth/CLI flow never has.
    expect(providerReadyCopy('dust')).toEqual({
      label: 'Dust · your agents connected',
      hint: 'finish the one-click sign-in to get live answers'
    })
  })

  it('leaves the CLI and API-key rows exactly as they read before', () => {
    expect(providerReadyCopy('claude-cli').hint).toBe('connect it to get live answers')
    expect(providerReadyCopy('claude-cli').label).toMatch(/ connected$/)
    expect(providerReadyCopy('anthropic')).toEqual({
      label: 'Claude · Anthropic API key',
      hint: 'add your key to get live answers'
    })
  })
})

describe('MQA-093 — a DENIED microphone is not the same row state as one that was never asked', () => {
  it('gives a denied mic its own "blocked" state so the dead "Allow Microphone" button gives way to ' +
      'the OS privacy pane', () => {
    // The bug: denied collapsed into 'action', whose only control calls requestPermissionsUpfront —
    // which main gates on 'not-determined', so every click was a no-op with no prompt and no link.
    expect(micRowStatus('denied')).toEqual({ state: 'blocked', detail: 'permission denied' })
    expect(micRowStatus('denied').state).not.toBe('action')
  })

  it('keeps every other status behaving as it did', () => {
    expect(micRowStatus('granted')).toEqual({ state: 'ready', detail: 'granted' })
    expect(micRowStatus('unknown')).toEqual({ state: 'action', detail: 'needs permission' })
    expect(micRowStatus(undefined)).toEqual({ state: 'action', detail: 'needs permission' })
  })
})

describe('MQA-201 — scene 4 never fakes a check', () => {
  // docs/ONBOARDING-EXPERIENCE.md: "Rows animate from spinner -> state, using REAL signals ... (only show
  // rows that are actually true - never fake a check.)" The acceleration row was an unconditional
  // set('silicon', 'ready', 'detected') justified by "this build only ships arm64" - false on both
  // shipped platforms: the mac target is universal (electron-builder.yml, built with --universal and
  // gate-verified for x64 Mach-O slices) and Windows ships x64 only. It also fed allReady, so a
  // fabricated row is what let the "Everything's ready" headline render.
  const src = readFileSync(join(__dirname, 'OnboardingExperience.tsx'), 'utf8')

  it('does not assert hardware acceleration it never checked', () => {
    expect(src).not.toMatch(/set\('silicon'/)
    expect(src).not.toMatch(/Apple Silicon acceleration|Hardware acceleration/)
    expect(src).not.toMatch(/this build only ships arm64/)
  })

  it('every remaining setup row is derived from a real signal', () => {
    // asrBundled / getPermissions, plus the two rows whose verdict is a platform fact the renderer
    // genuinely knows (the brain path, and Windows having no per-app screen-recording permission).
    expect(src).toMatch(/window\.toto\.asrBundled\(\)/)
    expect(src).toMatch(/window\.toto\.getPermissions\(\)/)
    expect(src).toMatch(/micRowStatus\(perms\?\.microphone\)/)
  })
})

/**
 * MQA-263 — onboarding asked the user to solve a problem they did not have.
 *
 * The installer can ship a Cloudflare key that main seeds into the keystore on first launch, so
 * `providerReady` is already true when step 5 renders. Step 5 nevertheless opened with "To get live
 * answers, pick one way to connect the AI", offered Claude Code / an API key / Mantu Dust, and its
 * escape hatch read "Something else (DeepSeek, Qwen, Mistral, and more)".
 *
 * Cloudflare — the provider actually configured and answering — was not among the options. So a user
 * whose install was already working was told to go and sign up for DeepSeek. Step 6 compounded it: the
 * generic branch of providerReadyCopy rendered "Cloudflare · AI Gateway API key — add your key to get
 * live answers" for a key they were never given a copy of.
 */
describe('MQA-263 — a build that ships connected must say so', () => {
  it('reports an already-connected provider as connected, not as needing a key', () => {
    const copy = providerReadyCopy('cloudflare', { alreadyConnected: true })
    expect(copy.hint).not.toMatch(/add your key/i)
    expect(copy.label).toMatch(/connected$/)
    expect(copy.hint).toMatch(/nothing to paste/i)
  })

  it('still tells an UNCONFIGURED key provider to add its key', () => {
    // The fix must not silence the case where the instruction is correct.
    const copy = providerReadyCopy('anthropic', { alreadyConnected: false })
    expect(copy.hint).toBe('add your key to get live answers')
  })

  it('leaves the CLI and Dust branches alone when not already connected', () => {
    expect(providerReadyCopy('claude-cli').hint).toBe('connect it to get live answers')
    expect(providerReadyCopy('dust').hint).toMatch(/one-click sign-in/)
  })

  it('treats the second argument as optional, so existing call sites keep working', () => {
    expect(providerReadyCopy('anthropic')).toEqual(providerReadyCopy('anthropic', {}))
  })
})
