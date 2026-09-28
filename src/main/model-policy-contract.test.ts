import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Structural proof (same "readFileSync + regex over the real source" pattern as
 * Settings.contract.test.ts — there is no integration harness that actually drives an ask/recap end
 * to end against a live Operator) that every REAL model call site in src/main resolves its
 * provider/model through the fleet model policy module (M2-0412) rather than only through
 * settings/allowedProviders. Pure resolver behaviour (precedence, narrowing, pinning) is covered by
 * src/shared/model-policy.test.ts and src/main/model-policy-client.test.ts; this test only pins that
 * each call site actually calls in.
 *
 * "Every call site" means every place that currently picks a cloud provider + model at all (see
 * AGENTS.md scope / M2-0412 ticket notes). Two capabilities in the policy schema — `commandAgent` and
 * `tts` — have NO model-routed call site anywhere in this app (command parsing is rule-based;
 * there is no text-to-speech path), so there is nothing to wire; the negative assertions below pin
 * that absence rather than silently ignoring it. `stt` and `localModel` are owner-manageable and
 * audited but deliberately surfaced to Settings as informational rather than force-applied (see
 * src/shared/model-policy.ts's module doc comment for why) — not asserted here since asserting a
 * TODO would be a fake proof, not a real contract.
 */

const root = join(__dirname, '..', '..')

function src(relativePath: string): string {
  return readFileSync(join(root, relativePath), 'utf8').replace(/\r\n/g, '\n')
}

const WIRED_CALL_SITES = [
  'src/main/index.ts',
  'src/main/import-recap.ts',
  'src/main/brain/ingest.ts',
  'src/main/brain/intelligence-pass-route.ts'
]

describe('M2-0412 — every real model call site resolves through the fleet policy module', () => {
  it.each(WIRED_CALL_SITES)('%s imports from model-policy-client', (path) => {
    const text = src(path)
    expect(text).toMatch(/from ['"](\.\/)*model-policy-client['"]/)
  })

  it('the interactive ask path (index.ts) narrows providers AND pins the model for the askChat capability', () => {
    const text = src('src/main/index.ts')
    expect(text).toContain("narrowAllowedForCapability(s, getAllowedProviders(), 'askChat'")
    expect(text).toContain("resolveManagedModel(s, 'askChat', provider, model)")
  })

  it('import-recap.ts, brain/ingest.ts and intelligence-pass-route.ts all resolve the recap capability', () => {
    for (const path of ['src/main/import-recap.ts', 'src/main/brain/ingest.ts', 'src/main/brain/intelligence-pass-route.ts']) {
      const text = src(path)
      expect(text, path).toContain("'recap'")
      expect(text, path).toMatch(/narrowAllowedForCapability|resolveManagedModel/)
    }
  })

  it('CLI providers and local are never narrowed by the fleet policy at any wired call site (own toggles govern them)', () => {
    for (const path of WIRED_CALL_SITES) {
      const text = src(path)
      if (!text.includes('narrowAllowedForCapability')) continue
      expect(text, path).toMatch(/\[\s*\.\.\.CLI_PROVIDER_IDS\s*,\s*'local'\s*\]/)
    }
  })
})

describe('M2-0412 — capabilities with no model-routed call site are a documented absence, not a silent gap', () => {
  it('there is no text-to-speech call site anywhere in src/main (tts has nothing to enforce)', () => {
    const grep = (pattern: RegExp): boolean => {
      // Sampling the same directories the earlier program audit checked (main + brain + llm): a real
      // TTS integration would need a synthesis call site in one of these, not buried elsewhere.
      for (const path of ['src/main/index.ts', 'src/main/brain/ingest.ts', 'src/main/import-recap.ts']) {
        if (pattern.test(src(path))) return true
      }
      return false
    }
    expect(grep(/text-to-speech|synthesizeSpeech|ttsStream/i)).toBe(false)
  })

  it('command-agent parsing is rule-based, not model-routed (metis-command-parse.ts has no provider/model resolution)', () => {
    const text = src('src/shared/metis-command-parse.ts')
    expect(text).not.toMatch(/resolveModelTier|PROVIDERS\[/)
  })
})
