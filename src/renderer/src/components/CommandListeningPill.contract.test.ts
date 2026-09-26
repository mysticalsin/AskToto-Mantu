import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(join(__dirname, 'CommandListeningPill.tsx'), 'utf8')

describe('Cap2 CommandListeningPill contract', () => {
  it('is top-center translucent pill with mic affordance', () => {
    expect(src).toMatch(/left-1\/2/)
    expect(src).toMatch(/top-3/)
    expect(src).toMatch(/backdrop-blur/)
    expect(src).toMatch(/data-metis-command-pill/)
    expect(src).toMatch(/Microphone|mic|viewBox=\"0 0 24 24\"/i)
  })

  it('plays single/double chime and Escape stop', () => {
    expect(src).toMatch(/playChime/)
    expect(src).toMatch(/double/)
    expect(src).toMatch(/Escape/)
    expect(src).toMatch(/aria-label="Stop command listening"/)
    expect(src).toMatch(/className="no-drag shrink-0/)
  })

  it('shows live transcript after listening copy', () => {
    expect(src).toMatch(/data-metis-command-transcript/)
    expect(src).toMatch(/listening/)
  })
})
