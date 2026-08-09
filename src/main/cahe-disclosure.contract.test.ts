import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * MQA-098 (docs/qa/BUG-LEDGER.md) — the Cahê pilot doc is a COMPLIANCE artifact, not prose.
 *
 * It previously told the pilot's security reviewer to "enter Cahê's Kimi Code key" by hand and stated the
 * key "is not included in this installer or source tree", while `electron-builder.cahe.win.yml` copies a
 * real key into `resources/cahe/kimi.json` and `cahe-embedded-key.ts` documents it as extractable by
 * anyone holding the installer. A reviewer reading only the doc would sign off on a threat model the
 * build does not implement.
 *
 * A doc cannot be pinned by exercising code, so this asserts the doc against the build config and the
 * source comment it is supposed to describe: if the embed is ever removed, or the disclosure is ever
 * softened back, exactly one of these fails.
 */
const repoRoot = join(__dirname, '..', '..')
const doc = readFileSync(join(repoRoot, 'docs', 'cahe-windows-edition.md'), 'utf8')
const caheBuilder = readFileSync(join(repoRoot, 'electron-builder.cahe.win.yml'), 'utf8')

describe('Cahê pilot doc discloses the embedded Kimi key (MQA-098)', () => {
  it('the build really does embed the key — the premise these assertions rest on', () => {
    // If this fails the embed was removed, and the doc assertions below should be revisited rather than
    // "fixed": the honest doc for a keyless build is the opposite of the honest doc for this one.
    expect(caheBuilder).toMatch(/resources\/cahe\/kimi\.json|cahe-kimi\.local\.json/)
  })

  it('never claims the key is absent from the installer', () => {
    const denials = [
      /not included in this installer/i,
      /is not included in this installer or source tree/i,
      /no key is shipped/i
    ]
    for (const pattern of denials) expect(doc).not.toMatch(pattern)
  })

  it('states plainly that the installer carries the key', () => {
    expect(doc).toMatch(/installer carries[^.]*Kimi/i)
    expect(doc).toMatch(/resources\/cahe\/kimi\.json/)
  })
})
