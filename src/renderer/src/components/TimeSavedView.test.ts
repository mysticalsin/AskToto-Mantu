import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(__dirname, 'TimeSavedView.tsx'), 'utf8')

describe('TimeSavedView — TIME-SAVED.md contract', () => {
  it('labels the headline as an estimate and never invents a percentage', () => {
    expect(source).toMatch(/estimate/)
    expect(source).toMatch(/≈/)
    expect(source).not.toMatch(/% saved|win rate|productivity/i)
    expect(source).not.toMatch(/—/)
    expect(source).not.toMatch(/I am an AI|as an AI/i)
    expect(source).not.toMatch(/purple-gradient|from-purple|to-pink/)
  })

  it('shows the four documented heuristics', () => {
    expect(source).toMatch(/180 wpm/)
    expect(source).toMatch(/2 min per captured opportunity/)
    expect(source).toMatch(/4 min/)
    expect(source).toMatch(/3 min/)
  })

  it('empty state is honest and does not show 0 hours saved as a trophy', () => {
    expect(source).toMatch(/Time saved appears when Métis finishes a note/)
  })
})
