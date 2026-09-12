import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, IPC, SettingsSchema } from './ipc'
import { preferredFreshAsrEngine } from './asr-hardware-preference'

const root = process.cwd()
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n')

describe('ASR engine fallback and fresh-setup contracts', () => {
  it('schema + DEFAULT_SETTINGS + listen/App fallbacks all default asrEngine to parakeet', () => {
    expect(DEFAULT_SETTINGS.asrEngine).toBe('parakeet')
    const { asrEngine: _omit, ...rest } = DEFAULT_SETTINGS
    expect(SettingsSchema.parse(rest).asrEngine).toBe('parakeet')
    expect(read('src/renderer/src/App.tsx')).toMatch(/settings\?\.asrEngine \?\? 'parakeet'/)
    expect(read('src/renderer/src/lib/listen.ts')).toMatch(
      /useRef<'whisper' \| 'parakeet' \| 'apple'>\('parakeet'\)/
    )
    expect(read('src/renderer/src/lib/listen.ts')).toMatch(
      /engine: 'whisper' \| 'parakeet' \| 'apple' = 'parakeet'/
    )
  })

  it('onboarding provisions ASR instead of skipping a missing bundle', () => {
    const onboard = read('src/renderer/src/components/OnboardingExperience.tsx')
    expect(onboard).toMatch(/asrAssetsEnsure/)
    expect(onboard).toMatch(/asrAssetsStatus/)
    expect(onboard).toMatch(/setupAsrBlocksContinue/)
    expect(onboard).toMatch(/firstRunCanFinish/)
    expect(onboard).toMatch(/asrAssetsEnsure\(\)/)
    expect(onboard).not.toMatch(/models missing in this build/)
    expect(onboard).not.toMatch(/[Rr]einstall Métis/)
    expect(read('src/preload/index.ts')).toMatch(/asrAssetsStatus/)
    expect(IPC.asrAssetsEnsure).toBe('asr:assets-ensure')
  })

  it('accepts RAM-specific fresh choices without changing the conservative legacy fallback', () => {
    const { asrEngine: _omit, ...legacy } = DEFAULT_SETTINGS
    expect(SettingsSchema.parse(legacy).asrEngine).toBe('parakeet')
    expect(SettingsSchema.parse({ ...legacy, asrEngine: preferredFreshAsrEngine(8 * 1024 ** 3) }).asrEngine).toBe('parakeet')
    expect(SettingsSchema.parse({ ...legacy, asrEngine: preferredFreshAsrEngine(16 * 1024 ** 3) }).asrEngine).toBe('whisper')
    // Settings.speech-models.test.tsx renders the real Speech UI and checks both device classes.
  })
})
