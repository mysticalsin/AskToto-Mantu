/**
 * a11y-2.12.contract.test.ts — G91 keyboard and screen-reader pins for 2.12 surfaces that the static-markup
 * tests cannot see: React drops `autoFocus` from server markup, the quiet and translation rows are embedded in
 * a settings tab with no seam, and reduced motion lives in CSS. Anchors are names, never line numbers.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../../test-helpers/module-source'

const src = (specifier: string): string => readModuleSource(__dirname, specifier).text.replace(/\r\n/g, '\n')
const from = (text: string, anchor: string, length = 900): string => {
  const at = text.indexOf(anchor)
  expect(at, anchor).toBeGreaterThanOrEqual(0)
  return text.slice(at, at + length)
}

describe('G91 accessibility contracts', () => {
  it('quiet mode select is labelled by its title and described by its help', () => {
    const row = from(src('./features/settings/AudioTab'), '<span id={quietTitleId}>Quiet mode</span>')
    expect(row).toMatch(/aria-labelledby=\{quietTitleId\}/)
    expect(row).toMatch(/aria-describedby=\{quietHelpId\}/)
  })

  it('live translation select is labelled by its title and described by its help', () => {
    const text = src('./features/settings/LiveTranslationRow')
    expect(text).toMatch(/<span id=\{titleId\}[^>]*>\s*Live translation/)
    expect(text).toMatch(/<span id=\{helpId\}>/)
    expect(text).toContain('aria-labelledby={titleId}')
    expect(text).toContain('aria-describedby={helpId}')
  })

  it('the translation line announces a "Translation:" prefix instead of an aria-label on a div', () => {
    const line = from(src('./components/Copilot'), '{translation && (', 500)
    expect(line).not.toContain('aria-label="Translation"')
    expect(line).toContain('<span className="sr-only">Translation: </span>')
  })

  it('edit and confirm surfaces move focus to their safe control on open', () => {
    expect(from(src('./components/MeetingRecordPanel'), '<textarea', 200)).toContain('autoFocus')
    expect(from(src('./components/MeetingRecordPanel'), 'aria-label={`Add to ${title}`}', 200)).toContain('autoFocus')
    const keep = src('./features/settings/OptionalComponentsSection')
    expect(keep).toMatch(/autoFocus[\s\S]{0,200}onClick=\{props\.onKeep\}[\s\S]{0,200}Keep it/)
  })

  it('speaking bars stop under prefers-reduced-motion: the global rule is !important', () => {
    const css = readFileSync(join(__dirname, 'styles/overlay-motion.css'), 'utf8').replace(/\r\n/g, '\n')
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toMatch(/\*,\s*\*::before,\s*\*::after\s*\{\s*animation-duration: 0ms !important;/)
  })
})
