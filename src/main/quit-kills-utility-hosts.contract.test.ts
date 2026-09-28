import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Source-contract test (same structural-proof pattern as will-quit-guard.test.ts): M2-0231's packaged
 * smoke found one of each Whisper-import, Parakeet, and speaker-embedding utilityProcess host surviving
 * quit on Windows — stopAllSidecars relied on the unwritten assumption that Electron ends every
 * utilityProcess on quit and exit alike, and never killed these three explicitly. This pins that each one
 * now gets its own signal-only kill inside stopAllSidecars, so a future edit can't silently drop one back
 * onto that unverified assumption.
 */
describe('stopAllSidecars kills every utilityProcess host it owns', () => {
  const source = readFileSync(join(__dirname, 'index.ts'), 'utf8').replace(/\r\n/g, '\n')
  const family = (() => {
    const start = source.indexOf('const stopAllSidecars = createStopAll(')
    expect(start).toBeGreaterThan(-1)
    const end = source.indexOf(')\n', source.indexOf('(name, error) =>', start))
    expect(end).toBeGreaterThan(start)
    return source.slice(start, end)
  })()

  it('kills the whisper-import host', () => {
    expect(family).toMatch(/stop:\s*\(\)\s*=>\s*void stopWhisperHost\(\)/)
  })

  it('kills the parakeet host', () => {
    expect(family).toMatch(/stop:\s*\(\)\s*=>\s*killParakeetHostForQuit\(\)/)
  })

  it('kills the speaker-embedding host', () => {
    expect(family).toMatch(/stop:\s*\(\)\s*=>\s*killSpeakerEmbeddingHostForQuit\(\)/)
  })
})
