import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = join(__dirname, '..', '..', '..', '..', '..')

describe('speech-pack public consumers', () => {
  it('is reachable through the main feature index, ASR resolver and Settings Audio tab', () => {
    const featureIndex = readFileSync(join(REPO, 'src/main/features/components/index.ts'), 'utf8')
    const ensure = readFileSync(join(REPO, 'src/main/asr-bundled-ensure.ts'), 'utf8')
    const audio = readFileSync(join(REPO, 'src/renderer/src/features/settings/AudioTab.tsx'), 'utf8')
    expect(featureIndex).toContain('./speech-pack/service')
    expect(ensure).toContain('./features/components/speech-pack/resolver')
    expect(audio).toContain('./SpeechPackSection')
  })

  it('keeps the Settings status read separate from explicit action dispatch', () => {
    const section = readFileSync(join(REPO, 'src/renderer/src/features/settings/SpeechPackSection.tsx'), 'utf8')
    expect(section).toContain('bridge.speechPackState()')
    expect(section).toContain('bridge.speechPackAction(')
    expect(section).not.toMatch(/speechPackAction\([^)]*download[^)]*\).*useEffect/s)
  })
})
