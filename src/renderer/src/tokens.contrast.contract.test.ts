import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * D10-6: Métis ships alpha-based ink, hairlines and glass, so contrast depends on the wallpaper. The OS
 * "Increase contrast" and forced-colors settings must change that, and must change nothing while off.
 */
const css = readFileSync(join(__dirname, 'tokens.css'), 'utf8').replace(/\r\n/g, '\n')

/** The body of the first `@media <query> { ... }` block, brace-balanced. */
function mediaBlock(query: string): string {
  const start = css.indexOf(`@media (${query})`)
  if (start < 0) return ''
  const open = css.indexOf('{', start)
  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, i)
    }
  }
  return ''
}

function declared(block: string, name: string): string | null {
  const m = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(block)
  return m ? m[1].trim() : null
}

describe('tokens.css increased-contrast and forced-colors support (D10-6)', () => {
  const more = mediaBlock('prefers-contrast: more')

  it('has a prefers-contrast: more block that raises ink and hairlines', () => {
    expect(more).not.toBe('')
    expect(declared(more, '--color-ink-2')).toMatch(/#fff\b|rgb\(255 255 255\)|rgba\(255, 255, 255, 1\)/)
    expect(declared(more, '--color-ink-3')).toBe('rgba(255, 255, 255, 0.92)')
    expect(declared(more, '--color-hair')).toBe('rgba(255, 255, 255, 0.32)')
    expect(declared(more, '--color-hair-strong')).toBe('rgba(255, 255, 255, 0.45)')
  })

  it('makes the glass, scrim and listening fills near-opaque', () => {
    for (const token of [
      '--glass-fill',
      '--glass-fill-elevated',
      '--glass-fill-strong',
      '--glass-scrim-bar',
      '--glass-fill-listening',
      '--glass-fill-strong-listening'
    ]) {
      expect(declared(more, token), token).toMatch(/\/\s*0\.96\)/)
    }
  })

  it('also overrides the scoped Settings and listening palettes, which would otherwise win', () => {
    expect(more).toMatch(/\.cl-root[\s\S]*--color-ink-2/)
    expect(more).toMatch(/\.listening[\s\S]*--color-ink-3/)
  })

  it('has a forced-colors block with a Highlight focus outline and ButtonText button borders', () => {
    const forced = mediaBlock('forced-colors: active')
    expect(forced).toMatch(/:focus-visible[^}]*Highlight/)
    expect(forced).toMatch(/button[^}]*ButtonText/)
  })

  it('leaves the default (OS setting off) values unchanged', () => {
    const outside = css.replace(more, '')
    expect(outside).toContain('--color-ink-3: rgba(255, 255, 255, 0.74)')
    expect(outside).toContain('--color-hair: rgba(255, 255, 255, 0.10)')
    expect(outside).toContain('--glass-fill: rgb(34 14 60 / calc(0.6 * var(--overlay-opacity-scale)))')
  })
})
