/**
 * packaged-model-claims.contract.test.ts — MQA-146.
 *
 * MQA-319 restores the compact default to the installer, without bundling the optional larger model.
 * Claims must distinguish those two cases. In particular, old tests must not simply skip every
 * document assertion when the builder starts including weights again.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const REPO = join(__dirname, '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n')

const builder = read('electron-builder.yml')
const manifest = read('src/main/llm/local-models.ts')
const settingsUi = read('src/renderer/src/components/Settings.tsx')

/** True when the builder copies the weights directory rather than only the licence file. */
const weightsArePackaged = /^\s*-\s*from:\s*resources\/local-llm\/models\s*$/m.test(builder)

describe('MQA-146/319 — local-model provenance follows the actual installer', () => {
  it('requires the compact weights and license in the builder rather than skipping disclosure checks', () => {
    expect(weightsArePackaged).toBe(true)
    expect(builder).toMatch(/resources\/local-llm\/LICENSE\.QWEN3\.5-APACHE-2\.0\.txt/)
  })

  it('the runtime half the doc still claims is true — the URL is commit-pinned, not a mutable tag', () => {
    // resolve/<40-hex-commit>/ rather than resolve/main/, which is what makes "immutable" true.
    expect(manifest).toMatch(/huggingface\.co\/unsloth\/Qwen[^'"]*\/resolve\/[0-9a-f]{40}\//)
    expect(manifest).not.toMatch(/huggingface\.co\/unsloth\/Qwen[^'"]*\/resolve\/(main|master)\//)
  })

  it('the sidecar genuinely IS bundled, so that half of the claim stays true', () => {
    expect(builder).toMatch(/resources\/llama/)
  })
})

/**
 * MQA-188/191/319 — the renderer must distinguish bundle repair from optional-download recovery.
 */
describe('MQA-188/191 — the in-app copy may not out-run what the installer actually ships', () => {
  const localAi = (): string => {
    const start = settingsUi.indexOf('function LocalAiSection(')
    const end = settingsUi.indexOf('\nfunction StepBadge(', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    // Strip `//` comments: they quote the old wording to explain why it was wrong, and no user reads them.
    return settingsUi.slice(start, end).replace(/^\s*\/\/.*$/gm, '')
  }

  it('identifies the included compact model and projector instead of claiming every model is included', () => {
    expect(localAi()).toMatch(/installer includes Qwen3\.5 0\.8B and its screenshot projector/i)
    expect(localAi()).toMatch(/model\.source === 'bundled'\s*\?\s*'Included with Métis\.'/)
  })

  it('offers repair for invalid bundled files, not an optional-download Retry', () => {
    const ui = localAi()
    expect(ui).toMatch(/Repair or reinstall Métis/i)
    expect(ui).toMatch(/model\.unavailableReason === 'invalid-bundle'\s*\?\s*invalidBundleText/)
    const retry = ui.slice(ui.indexOf('const canRetry ='), ui.indexOf('const percent ='))
    expect(retry).toContain('download-failed')
    expect(retry).not.toContain('invalid-bundle')
  })

  it('discloses that the optional 4B download requires selection and opt-in or Retry', () => {
    expect(localAi()).toMatch(/optional 4B model downloads only after selecting it and enabling Local AI or choosing Retry/i)
    expect(localAi()).toMatch(/Retry to download without enabling/i)
  })
})

/**
 * MQA-243 — the same claim, every document that makes it.
 *
 * Discovered by grep, not by a test: the packaging claim above lived in three live documents and only
 * one of them was guarded. The list is enumerated rather than globbed over docs/ because most of what
 * is under there is a dated record — plans, design notes, past QA runs, the bug ledger itself — and
 * those are supposed to say what was true when they were written. These three describe the product as
 * it ships today, so they are the ones that must not lie about it.
 */
describe('MQA-243/319 — live documents distinguish the bundled default and optional download', () => {
  const LIVE_DOCS = [
    'docs/compliance/data-flow-onepager.md',
    'docs/compliance/legitimate-interest-assessment.md',
    'docs/asktoto-architecture.md',
    'docs/ENTERPRISE-DEPLOY-WINDOWS.md'
  ] as const

  it('the guarded list is non-empty — an empty sweep would pass silently forever', () => {
    // The failure mode this whole block exists to prevent is a check that quietly measures nothing.
    expect(LIVE_DOCS.length).toBeGreaterThanOrEqual(3)
  })

  for (const rel of LIVE_DOCS) {
    const doc = read(rel).replace(/\*\*/g, '').replace(/\s+/g, ' ')

    it(`${rel} states that the compact default is bundled and does not claim an automatic upgrade`, () => {
      expect(doc).toMatch(/Qwen3\.5 0\.8B default is bundled/i)
      expect(doc).not.toMatch(/chosen by host RAM|whichever the host.s RAM supports|selects the largest registered model|picks the largest registered model|4B that any machine with 8 GB/i)
    })

    it(`${rel} discloses optional 4B download, immutable pins, and offline default availability`, () => {
      expect(doc).toMatch(/optional Qwen3\.5 4B[\s\S]{0,180}(?:download|fetch)/i)
      expect(doc).toMatch(/explicit/i)
      expect(doc).toMatch(/immutable|commit-pinned/)
      expect(doc).toMatch(/SHA-256/)
      expect(doc).toMatch(/offline|air-gapped|no outbound internet/i)
    })
  }

  /**
   * The size figures are the part an enterprise provisions against, so they have to come from the
   * manifest rather than from whoever last edited the prose. Default installer capacity and optional
   * 4B download capacity are separate figures; hardware does not silently select a larger download.
   */
  it('every quoted model size agrees with the immutable registry', () => {
    const declared = [...manifest.matchAll(/bytes:\s*(\d{6,})/g)].map((m) => Number(m[1]))
    expect(declared.length, 'manifest byte lengths not found').toBeGreaterThanOrEqual(4)
    expect(declared.length % 2, 'every model must declare both a gguf and an mmproj length').toBe(0)

    const downloads = new Set<number>()
    for (let i = 0; i < declared.length; i += 2) {
      downloads.add(declared[i] + declared[i + 1])
      downloads.add(declared[i])
    }

    for (const rel of ['docs/compliance/data-flow-onepager.md', 'docs/ENTERPRISE-DEPLOY-WINDOWS.md']) {
      const quoted = [...read(rel).matchAll(/([\d,]{9,})\s*bytes/g)].map((m) => Number(m[1].replace(/,/g, '')))
      expect(quoted.length, `${rel} quotes no byte figure at all`).toBeGreaterThan(0)
      for (const q of quoted) {
        expect(
          [...downloads],
          `${rel} quotes ${q.toLocaleString('en-US')} bytes, which is not a reviewed model payload`
        ).toContain(q)
      }
    }

    // Enterprise tooling still needs the larger optional download size, without calling it the default.
    const biggest = Math.max(...[...downloads])
    expect(read('docs/ENTERPRISE-DEPLOY-WINDOWS.md').replace(/,/g, '')).toContain(String(biggest))
  })
})
