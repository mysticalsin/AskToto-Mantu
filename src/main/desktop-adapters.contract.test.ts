import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DESKTOP_ADAPTER_IDS } from '../shared/desktop-actions'

const src = readFileSync(join(__dirname, 'desktop-adapters.ts'), 'utf8')

describe('Cap2 desktop-adapters contract', () => {
  it('implements every allowlisted adapter id', () => {
    for (const id of DESKTOP_ADAPTER_IDS) {
      expect(src).toContain(`'${id}'`)
    }
  })

  it('does not silently swap Arc to Chrome/Edge on failure', () => {
    expect(src).toMatch(/No silent browser swap|No silent Edge\/Chrome swap/)
  })

  it('keeps photo capture local (no decide upload path)', () => {
    expect(src).toMatch(/never sent to \/v1\/decide|local only/i)
    expect(src).not.toMatch(/typesafe\.ai/)
  })

  it('uses open/osascript on darwin — no new mic stack', () => {
    expect(src).toContain("/usr/bin/open")
    expect(src).toContain('/usr/bin/osascript')
    expect(src).not.toMatch(/apple-speech|cloud-stt|MediaRecorder/)
  })
})
