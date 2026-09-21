import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(join(__dirname, 'CommandListeningPill.tsx'), 'utf8')

describe('Cap2 CommandListeningPill contract', () => {
  it('shows Cap4 Jarvis ObsidianOrb turning in listening state', () => {
    expect(src).toMatch(/left-1\/2/)
    expect(src).toMatch(/top-3/)
    expect(src).toMatch(/data-metis-command-pill/)
    expect(src).toMatch(/data-metis-command-listen-orb/)
    expect(src).toContain('ObsidianOrb')
    expect(src).toMatch(/listening/)
    expect(src).toMatch(/animate/)
    expect(src).not.toContain('JarvisOrbButton')
  })

  it('plays single/double chime and Escape stop', () => {
    expect(src).toMatch(/playChime/)
    expect(src).toMatch(/double/)
    expect(src).toMatch(/Escape/)
    expect(src).toMatch(/aria-label="Stop command listening"/)
  })

  it('shows live transcript after listening copy', () => {
    expect(src).toMatch(/data-metis-command-transcript/)
    expect(src).toMatch(/listening/)
  })
})
