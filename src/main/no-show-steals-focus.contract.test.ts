import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

/**
 * no-show-steals-focus.contract.test.ts — MQA-275, Phase 1d of the Métis × Vibe-Island rebuild.
 *
 * The overlay's non-activating contract: `BrowserWindow#show()` (unlike `#showInactive()`) grabs OS
 * focus on both macOS and Windows, stealing it from whatever app the user was in. The island must never
 * do that except the ONE deliberate case — the user explicitly asked to type (`showForAsk`, see its doc
 * comment in index.ts). This test greps the shipped source for every `win.show()`/`w.show()` call (the
 * two identifiers index.ts uses for its BrowserWindow reference) and fails if any sit outside
 * `showForAsk`'s own body — so a future PR that reaches for `.show()` on a reveal path fails loudly here
 * instead of silently reintroducing a focus-theft regression. Same source-contract idiom as
 * license-enforcement-drift.contract.test.ts / index-audit-fixes.contract.test.ts.
 */
const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8')

/** Brace-counted function body extraction — robust to nested blocks (unlike a marker-to-marker slice,
 *  which breaks the moment a sibling function's name changes). */
function functionBody(name: string): { start: number; end: number; text: string } {
  const marker = `function ${name}(`
  const start = indexSrc.indexOf(marker)
  expect(start, `${name} not found in index.ts`).toBeGreaterThan(-1)
  const braceOpen = indexSrc.indexOf('{', start)
  expect(braceOpen, `${name}: opening brace not found`).toBeGreaterThan(-1)
  let depth = 0
  let i = braceOpen
  for (; i < indexSrc.length; i++) {
    if (indexSrc[i] === '{') depth++
    else if (indexSrc[i] === '}') {
      depth--
      if (depth === 0) break
    }
  }
  expect(i, `${name}: matching closing brace not found`).toBeLessThan(indexSrc.length)
  return { start, end: i + 1, text: indexSrc.slice(start, i + 1) }
}

describe('MQA-275 — the overlay never steals focus except the one deliberate ask exception', () => {
  it('showForAsk exists, calls show()+focus(), and its doc comment names it as the one exception', () => {
    const { text } = functionBody('showForAsk')
    expect(text).toMatch(/\.show\(\)/)
    expect(text).toMatch(/\.focus\(\)/)
    const fnStart = indexSrc.indexOf('function showForAsk(')
    const docStart = indexSrc.lastIndexOf('/**', fnStart)
    const doc = indexSrc.slice(docStart, fnStart)
    expect(doc).toContain('ONE deliberate')
    expect(doc).toContain('no-show-steals-focus.contract.test.ts')
  })

  it('every win.show()/w.show() call site in index.ts sits inside showForAsk', () => {
    const { start: showForAskStart, end: showForAskEnd } = functionBody('showForAsk')
    const showCall = /\b(?:win|w)\??\.show\(\)/g
    const offenders: number[] = []
    let m: RegExpExecArray | null
    while ((m = showCall.exec(indexSrc))) {
      const insideShowForAsk = m.index >= showForAskStart && m.index < showForAskEnd
      if (!insideShowForAsk) offenders.push(m.index)
    }
    const lines = offenders.map((idx) => indexSrc.slice(0, idx).split('\n').length)
    expect(offenders, `win.show()/w.show() found outside showForAsk at index.ts line(s): ${lines.join(', ')}`).toEqual([])
  })

  it('sanity: the sweep pattern actually matches something (a silently-broken regex is worse than no test)', () => {
    const showCall = /\b(?:win|w)\??\.show\(\)/g
    const matches = indexSrc.match(showCall) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(1) // showForAsk's own call, at minimum
  })

  it('Notification#show() calls (an unrelated API — system toasts, not window focus) are left untouched', () => {
    expect(indexSrc).toContain('notification.show()')
    expect(indexSrc).toContain("body: 'Métis is linked to your Dust workspace.'")
  })

  it('the known non-activating conversions from the Phase 1d audit are all present', () => {
    // The 7 sites the audit found calling plain win.show()/w.show(): a notification click, sendHotkey(),
    // toggleVisible()'s reveal (both routed through showForAsk/showInactive inside those functions,
    // covered by the sweep above), two tray menu items (now delegate to sendHotkey with no separate
    // show() at all), second-instance, and app.on('activate'). Named here so the intent is explicit even
    // though the sweep test above is what actually enforces it.
    expect(indexSrc).toContain('win?.showInactive()') // notification click
    expect(indexSrc).toContain('if (!w.isVisible()) w.showInactive()') // second-instance
    expect(indexSrc).toContain("else win.showInactive()") // app.on('activate')
    // The two tray menu items (Settings…, Today's agenda) no longer call win.show() at all — they let
    // sendHotkey() reveal (non-activating, since neither action is 'ask').
    expect(indexSrc).not.toMatch(/label: 'Settings…', click: \(\) => \{\s*\n\s*if \(win/)
  })
})
