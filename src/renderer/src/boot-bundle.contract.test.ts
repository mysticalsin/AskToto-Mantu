import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname)
const APP = readFileSync(join(ROOT, 'App.tsx'), 'utf8')
const MAIN = readFileSync(join(ROOT, 'main.tsx'), 'utf8')
const MARKDOWN = readFileSync(join(ROOT, 'components', 'Markdown.tsx'), 'utf8')

/**
 * Boot-chunk pins for the dead-code / bundle pass. Overlay Island/Hide/Bar behavior is not
 * in scope — these only lock what must stay out of the eager renderer parse.
 */
describe('boot chunk keeps first-run and markdown weight lazy', () => {
  it('OnboardingV2 is a lazy() import, not a static module load', () => {
    expect(APP).toMatch(/const OnboardingV2 = lazy\(\(\) =>/)
    expect(APP).toMatch(/import\('\.\/components\/OnboardingExperience'\)/)
    expect(APP).not.toMatch(/^import \{ OnboardingV2 \}/m)
    expect(APP).toMatch(/<Suspense fallback=\{/)
  })

  it('streamdown CSS is owned by Markdown, not the eager main entry', () => {
    expect(MAIN).not.toMatch(/streamdown\/styles\.css/)
    expect(MARKDOWN).toMatch(/import 'streamdown\/styles\.css'/)
  })
})

describe('removed dead renderer surfaces stay gone', () => {
  const dead = [
    'components/MeetingDetectedToast.tsx',
    'components/ControlBar.tsx',
    'components/RecordingIndicator.tsx',
    'components/Logo.tsx',
    'lib/whisper-worklet.ts',
    'lib/audio-worklet.d.ts'
  ]

  it.each(dead)('does not ship %s', (rel) => {
    expect(existsSync(join(ROOT, rel))).toBe(false)
  })
})
