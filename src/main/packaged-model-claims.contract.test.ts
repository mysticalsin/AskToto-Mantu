/**
 * packaged-model-claims.contract.test.ts — MQA-146.
 *
 * The Qwen weights are deliberately NOT packaged (electron-builder.yml says why: ~728 MB pushed a
 * universal macOS package past GitHub's 2 GB per-asset release limit), and `local-model-download.ts`
 * fetches them once on first run from a commit-pinned URL, verifying size + SHA-256 before use. That is
 * a sound design and `check-offline-package.mjs` already allowlists exactly those two files.
 *
 * What went wrong is the same shape as MQA-068: an artifact went on asserting the old behaviour.
 * docs/compliance/data-flow-onepager.md — a document written for a customer's security review — still
 * said the packages "include Qwen3.5 0.8B" and that "the installed app does not download a model or
 * inference runtime". Verified against a real `npm run dist:win`: zero .gguf files in the package.
 *
 * So this pins the RELATIONSHIP, not the prose. While the builder does not package the weights, the
 * compliance doc may not claim it does; package them again and these tests demand the doc move with it.
 * The runtime half (the sidecar IS bundled, the URL IS commit-pinned, size+sha256 ARE enforced) is
 * asserted too, because those are the mitigations the corrected doc now offers in their place.
 *
 * MQA-243 — and then it happened again, because this file only ever read ONE document. The claim it
 * exists to police ("the installer contains the weights") was repeated in two more live documents that
 * no test could see: docs/asktoto-architecture.md said the model "and native runtime are embedded in
 * the same DMG/EXE" with "no post-install model download required" — both halves false — and
 * docs/compliance/legitimate-interest-assessment.md, the one an enterprise security review actually
 * reads, still named the 0.8B and its ~728 MB. An assertion scoped to its own file rather than to its
 * own claim passes while the thing it guards is broken somewhere else. The sweep below therefore runs
 * over every document that makes the claim, and fails if that list is ever empty.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const REPO = join(__dirname, '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n')

const builder = read('electron-builder.yml')
const compliance = read('docs/compliance/data-flow-onepager.md')
const manifest = read('src/main/llm/local-models.ts')
const settingsUi = read('src/renderer/src/components/Settings.tsx')

/** True when the builder copies the weights directory rather than only the licence file. */
const weightsArePackaged = /^\s*-\s*from:\s*resources\/local-llm\/models\s*$/m.test(builder)

describe('MQA-146 — the compliance one-pager may not out-run what the installer actually ships', () => {
  it('reads the builder config, so a rename fails loudly instead of silently passing', () => {
    expect(builder).toMatch(/resources\/local-llm\/LICENSE\.QWEN3\.5-APACHE-2\.0\.txt/)
  })

  it('does not claim the packages contain the weights while they are excluded', () => {
    if (weightsArePackaged) return
    // The exact sentence that was false, and the blanket claim that went with it.
    expect(compliance).not.toMatch(/packages\s*\n?\s*include Qwen3\.5/)
    expect(compliance).not.toMatch(/does not download a model or inference runtime/)
  })

  it('states plainly that the weights are fetched on first run', () => {
    if (weightsArePackaged) return
    expect(compliance).toMatch(/not\*\* in the\s*\n?\s*installer|are \*\*not\*\*/)
    expect(compliance).toMatch(/first run/)
  })

  it('offers the mitigations in their place — pinned revision, size and hash verified', () => {
    if (weightsArePackaged) return
    expect(compliance).toMatch(/immutable upstream revision|commit-pinned/)
    expect(compliance).toMatch(/SHA-256/)
    // A security reviewer's first question about any runtime fetch.
    expect(compliance).toMatch(/no meeting content|carries no meeting content/)
  })

  it('answers the air-gap question the exclusion creates', () => {
    if (weightsArePackaged) return
    expect(compliance).toMatch(/[Aa]ir-gapped|no outbound internet/)
    // ...and does not leave the reader thinking transcription broke too.
    expect(compliance).toMatch(/ASR is unaffected/)
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
 * MQA-188/191 — the renderer was left behind when the weights were unbundled.
 *
 * MQA-146 corrected the document that goes to a customer's security review, but the test it left behind
 * reads only the builder config, that document and the main-process manifest. The Settings card went on
 * saying "The model is Included with Métis. There is no separate model download after installation." and
 * offering "Reinstall Métis to restore them" — a remedy scripts/check-packaged-runtime.mjs guarantees
 * cannot work, since it fails the build if a .gguf ever reappears under resources/local-llm.
 *
 * So bind the UI to the builder the same way: while the weights are excluded, the app may not claim
 * otherwise in front of a user. Package them again and this test demands the copy move with them.
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

  it('does not tell the user the model is included with the app', () => {
    if (weightsArePackaged) return
    expect(localAi()).not.toMatch(/Included with Métis|no separate model download/i)
  })

  it('does not offer reinstalling as the remedy for weights the installer does not carry', () => {
    if (weightsArePackaged) return
    expect(localAi()).not.toMatch(/[Rr]einstall/)
  })

  it('says instead that the optional model is fetched after opt-in or explicit Retry', () => {
    if (weightsArePackaged) return
    expect(localAi()).toMatch(/downloads automatically only after you enable Local AI/i)
    expect(localAi()).toMatch(/Retry to download without enabling/i)
    expect(localAi()).not.toMatch(/first run|when the app opens|when Métis opens/i)
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
describe('MQA-243 — no live document may claim the installer carries the weights', () => {
  const LIVE_DOCS = [
    'docs/compliance/data-flow-onepager.md',
    'docs/compliance/legitimate-interest-assessment.md',
    'docs/asktoto-architecture.md'
  ] as const

  it('the guarded list is non-empty — an empty sweep would pass silently forever', () => {
    // The failure mode this whole block exists to prevent is a check that quietly measures nothing.
    expect(LIVE_DOCS.length).toBeGreaterThanOrEqual(3)
  })

  for (const rel of LIVE_DOCS) {
    const doc = read(rel)

    it(`${rel} does not claim the weights are bundled/embedded in the installer`, () => {
      if (weightsArePackaged) return
      // Deliberately narrow: the offence is asserting the WEIGHTS ship. The sidecar, the runtime and
      // the licence text genuinely are bundled, and every one of these docs says so correctly.
      expect(doc).not.toMatch(/bundled Qwen/i)
      expect(doc).not.toMatch(/model[^.\n]{0,80}embedded in the same (?:DMG|EXE|package)/i)
      expect(doc).not.toMatch(/no (?:post-install )?model download is required/i)
    })

    it(`${rel} states the first-run fetch instead`, () => {
      if (weightsArePackaged) return
      expect(doc).toMatch(/first run|once per user profile/i)
    })
  }

  /**
   * The size figures are the part an enterprise provisions against, so they have to come from the
   * manifest rather than from whoever last edited the prose. bestModelForMachine() ranks by weight
   * size and every entry's RAM floor is 8 GB today, so any supported host takes the LARGEST entry —
   * that is the number egress and per-user disk must be sized for.
   */
  it('every size a live doc quotes is a real first-run download from local-models.ts', () => {
    // A quoted figure is the TOTAL a user's machine actually pulls — gguf + mmproj — not either file
    // on its own, because both land before the model can serve anything. local-models.ts lists them in
    // that order per entry, so consecutive pairs are the per-model downloads.
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
          `${rel} quotes ${q.toLocaleString('en-US')} bytes, which is not any model's first-run download`
        ).toContain(q)
      }
    }

    // And the number an enterprise provisions against must be the LARGEST, since bestModelForMachine()
    // hands every host that clears the RAM floor the biggest entry.
    const biggest = Math.max(...[...downloads])
    expect(read('docs/ENTERPRISE-DEPLOY-WINDOWS.md').replace(/,/g, '')).toContain(String(biggest))
  })
})
