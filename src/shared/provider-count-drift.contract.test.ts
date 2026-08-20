/**
 * provider-count-drift.contract.test.ts — MQA-218.
 *
 * Adding a provider is a one-line change to `PROVIDERS`, and it silently falsifies every doc that
 * wrote the count down. That has now happened twice: `local` took the registry from 16 to 17 and the
 * README/architecture docs stayed at 16; `cloudflare` took it to 18 and they stayed at 16 again, so
 * the repo's front page advertised a provider list that omitted the two most interesting entries
 * (the on-device model, and the one provider reached through infrastructure the operator deploys).
 *
 * A number written in prose cannot defend itself, so this file makes the registry defend it: every
 * "N providers" claim in a shipped doc must equal a count the registry actually supports, and the
 * newest id must appear where the docs enumerate providers. Add a provider and these fail until the
 * docs move with it — which is the coupling that was missing.
 *
 * Deliberately NOT asserted: that a specific number appears. The docs are free to drop the count and
 * point at `src/shared/providers.ts` instead (docs/asktoto-architecture.md now does), which is the
 * better fix; this test only refuses a number that is WRONG.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { PROVIDERS, PROVIDER_IDS } from './providers'

const REPO = join(__dirname, '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n')

/** Every id in the registry. */
const total = PROVIDER_IDS.length
/** Everything that sends text off this machine — the count a compliance recipient list cares about. */
const remote = PROVIDER_IDS.filter((id) => id !== 'local').length
/** The registry minus the generic custom-endpoint escape hatch, which docs name separately. */
const named = PROVIDER_IDS.filter((id) => id !== 'custom').length
/** The three readings a doc can honestly mean. Deduped: today `remote` and `named` coincide. */
const LEGITIMATE = [...new Set([total, remote, named])]

/** Docs that describe the provider surface to a reader who cannot check the code. */
const DOCS = [
  'README.md',
  'docs/asktoto-architecture.md',
  'docs/compliance/README.md',
  'docs/compliance/dpia.md',
  'docs/compliance/article-30-record.md',
  'docs/compliance/tenant-checklist.md',
  'docs/compliance/data-flow-onepager.md'
]

// "18 AI providers", "17-provider registry", "18 selectable providers", "of the 17 supported providers".
const COUNT_CLAIM = /(\d+)[- ](?:selectable |AI |remote |cloud LLM |configured |supported )*providers?\b/gi

describe('MQA-218 — no shipped doc may state a provider count the registry contradicts', () => {
  it('reads the registry rather than a copy of it, so a rename fails loudly instead of passing', () => {
    expect(PROVIDER_IDS.length).toBeGreaterThan(0)
    expect(PROVIDER_IDS).toContain('local')
    expect(PROVIDER_IDS).toContain('custom')
  })

  for (const rel of DOCS) {
    it(`${rel} states no provider count that disagrees with PROVIDERS`, () => {
      const doc = read(rel)
      const claims: number[] = []
      for (const m of doc.matchAll(COUNT_CLAIM)) claims.push(Number(m[1]))
      for (const claim of claims) {
        expect(
          LEGITIMATE,
          `${rel} claims ${claim} providers; the registry has ${total} ids (${remote} remote, ${named} excluding the custom endpoint)`
        ).toContain(claim)
      }
    })
  }

  it('the newest provider is named where the README enumerates them, not just counted', () => {
    // A count that happens to be right while the list is missing an entry is the same lie in a
    // different shape — the arc that added Cloudflare left exactly that state behind.
    const readme = read('README.md')
    expect(readme).toMatch(/Cloudflare/)
    expect(readme).toMatch(/docs\/CLOUDFLARE\.md/)
    expect(readme).toMatch(/Métis Local/)
  })

  it('the compliance pack names every remote provider it can send meeting content to', () => {
    // The Art 30 recipients row is a legal register, not a marketing list: a provider a user can
    // select in Settings today and that is absent from it is an unrecorded processor.
    const record = read('docs/compliance/article-30-record.md').toLowerCase()
    for (const id of PROVIDER_IDS) {
      // `local` never transmits; `custom` is whatever the user points it at and is named as a class;
      // the CLI backends are local subprocesses the user has already authenticated themselves.
      if (id === 'local' || id === 'custom' || PROVIDERS[id].kind === 'cli') continue
      // Match on the id, not the label: PROVIDERS.anthropic is labelled "Claude" while the register
      // (correctly) names the company. The id is the stable token both sides share.
      expect(record, `article-30-record.md does not name the ${id} provider as a recipient`).toContain(id)
    }
  })
})
