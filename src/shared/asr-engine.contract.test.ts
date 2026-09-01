import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, IPC, SettingsSchema } from './ipc'

const root = process.cwd()
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n')

describe('ASR engine ship — Whisper default when Parakeet weights are absent', () => {
  it('schema + DEFAULT_SETTINGS + listen/App fallbacks all default asrEngine to whisper', () => {
    expect(DEFAULT_SETTINGS.asrEngine).toBe('whisper')
    const { asrEngine: _omit, ...rest } = DEFAULT_SETTINGS
    expect(SettingsSchema.parse(rest).asrEngine).toBe('whisper')
    expect(read('src/renderer/src/App.tsx')).toMatch(/settings\?\.asrEngine \?\? 'whisper'/)
    expect(read('src/renderer/src/lib/listen.ts')).toMatch(
      /useRef<'whisper' \| 'parakeet' \| 'apple'>\('whisper'\)/
    )
    expect(read('src/renderer/src/lib/listen.ts')).toMatch(
      /engine: 'whisper' \| 'parakeet' \| 'apple' = 'whisper'/
    )
  })

  it('listen and import re-resolve from disk instead of latching leftover meetings to Whisper', () => {
    const listen = read('src/renderer/src/lib/listen.ts')
    expect(listen).toMatch(/st\.ready \? 'parakeet' : 'whisper'/)
    expect(listen).toMatch(/prior session's fallback must not latch leftover meetings/)
    const index = read('src/main/index.ts')
    expect(index).toMatch(/resolveLeftoverAsrEngine/)
    expect(index).toMatch(/parakeetReady: parakeetModelReady\(\)/)
    expect(index).not.toMatch(/leftoverEngine\s*=\s*'whisper'/)
  })
})

describe('onboarding provisions high-accuracy Parakeet instead of skipping a missing bundle', () => {
  it('requests the high-accuracy artifact and will not mark ready until files exist', () => {
    const onboard = read('src/renderer/src/components/OnboardingExperience.tsx')
    expect(onboard).toMatch(/asrAssetsEnsure/)
    expect(onboard).toMatch(/asrAssetsStatus/)
    expect(onboard).toMatch(/setupAsrBlocksContinue/)
    expect(onboard).toMatch(/firstRunCanFinish/)
    expect(onboard).toMatch(/asrStatusIsReady/)
    expect(onboard).toMatch(/status\?\.ready === true/)
    expect(onboard).not.toMatch(/models missing in this build/)
    expect(onboard).not.toMatch(/[Rr]einstall Métis/)
    expect(onboard).toMatch(/Retry/)
    expect(read('src/preload/index.ts')).toMatch(/asrAssetsStatus/)
    expect(IPC.asrAssetsEnsure).toBe('asr:assets-ensure')
    const ensure = read('src/main/asr-bundled-ensure.ts')
    expect(ensure).toMatch(/PARAKEET_ARCHIVE_URL/)
    expect(ensure).toMatch(/sherpa-onnx-nemo-parakeet-tdt-0\.6b-v3-int8/)
    expect(ensure).toMatch(/highAccuracyParakeetReady/)
    expect(ensure).toMatch(/embedding\.onnx/)
    expect(ensure).toMatch(/join\('speaker'/)
  })
})
