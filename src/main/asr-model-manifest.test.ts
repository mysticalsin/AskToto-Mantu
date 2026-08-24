import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HIGH_TIER_ASR_MODEL, asrModelBytes, asrModelFileUrl } from './asr-model-manifest'

/**
 * MQA-247 — the high-accuracy transcription model's pin.
 *
 * These are the assertions that would have caught the two defects behind this feature: a manifest pointing
 * at a mutable ref (so two builds embed different bytes under one version), and a manifest whose model id
 * has drifted from the one the host actually looks for (so the fetch succeeds and the loader still picks
 * the floor). Both are silent failures, which is why they are pinned rather than trusted.
 */
describe('MQA-247 — the high-tier ASR manifest', () => {
  const host = readFileSync(join(__dirname, 'whisper-asr-host.ts'), 'utf8')

  it('pins an immutable commit, never a branch', () => {
    // scripts/fetch-models.mjs builds its URLs as /resolve/main/ — a MUTABLE ref. That is exactly the
    // reproducibility hole packaged-model-claims.contract.test.ts closes for the LLM weights, and the ASR
    // side had no equivalent rule until this one.
    expect(HIGH_TIER_ASR_MODEL.revision).toMatch(/^[0-9a-f]{40}$/)
    expect(HIGH_TIER_ASR_MODEL.revision).not.toBe('main')
    for (const file of HIGH_TIER_ASR_MODEL.files) {
      const url = asrModelFileUrl(HIGH_TIER_ASR_MODEL, file)
      expect(url).toContain(`/resolve/${HIGH_TIER_ASR_MODEL.revision}/`)
      expect(url).not.toMatch(/\/resolve\/(main|master)\//)
    }
  })

  it('every file carries a real byte length and a full SHA-256', () => {
    expect(HIGH_TIER_ASR_MODEL.files.length).toBeGreaterThanOrEqual(7)
    const seen = new Set<string>()
    for (const file of HIGH_TIER_ASR_MODEL.files) {
      expect(file.bytes, `${file.path} has no size`).toBeGreaterThan(0)
      expect(file.sha256, `${file.path} has a malformed digest`).toMatch(/^[0-9a-f]{64}$/)
      expect(seen.has(file.path), `${file.path} listed twice`).toBe(false)
      seen.add(file.path)
    }
  })

  it('the model id matches the tier the host actually looks for', () => {
    // Two copies of a string in two files is how a fetch lands 1.61 GB in a directory nothing reads. The
    // id is also the on-disk directory name transformers.js resolves, so a drift here is silent.
    expect(host).toContain(`id: '${HIGH_TIER_ASR_MODEL.id}'`)
    const firstTier = host.slice(host.indexOf('const MODEL_TIERS'), host.indexOf('const MODEL_REVISION'))
    expect(firstTier.indexOf(HIGH_TIER_ASR_MODEL.id), 'the manifest model is not the FIRST tier').toBeGreaterThan(-1)
  })

  it('reports a total that matches the sum, and is the size the copy quotes', () => {
    const total = HIGH_TIER_ASR_MODEL.files.reduce((n, f) => n + f.bytes, 0)
    expect(asrModelBytes()).toBe(total)
    // ~1.61 GB. If this ever changes, the user-facing size in Settings has to change with it — that copy
    // is what someone on a metered connection agrees to before the transfer starts.
    expect(total).toBeGreaterThan(1.5e9)
    expect(total).toBeLessThan(1.8e9)
  })

  it('the packaged app deliberately does NOT ship it — the exclusion and the fetch must agree', () => {
    // If someone ever un-excludes it, this fetch becomes dead weight AND the installer breaches GitHub's
    // 2 GiB per-asset limit. The two decisions are one decision.
    const builder = readFileSync(join(__dirname, '..', '..', 'electron-builder.yml'), 'utf8')
    expect(builder).toContain(`!${HIGH_TIER_ASR_MODEL.id}/**`)
  })
})
