import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, SettingsSchema } from './ipc'
import { LANGUAGE_NAMES } from './lang-id'

const root = process.cwd()
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n')

describe('ASR quality ship — stored preference and truthful runtime reporting', () => {
  it('schema + DEFAULT_SETTINGS + listen/App fallbacks all default asrQuality to best', () => {
    expect(DEFAULT_SETTINGS.asrQuality).toBe('best')
    const { asrQuality: _omit, ...rest } = DEFAULT_SETTINGS
    expect(SettingsSchema.parse(rest).asrQuality).toBe('best')
    expect(read('src/renderer/src/App.tsx')).toMatch(/settings\?\.asrQuality \?\? 'best'/)
    expect(read('src/renderer/src/lib/listen.ts')).toMatch(/useRef<'best' \| 'fast'>\('best'\)/)
    expect(read('src/renderer/src/lib/listen.ts')).toMatch(/quality: 'best' \| 'fast' = 'best'/)
    expect(read('src/renderer/src/lib/listen.ts')).toMatch(
      /const warmQuality = asrQuality === 'fast' \? 'fast' : 'best'/
    )
    expect(read('src/renderer/src/App.tsx')).toMatch(/settings\?\.asrQuality \?\? 'best'/)
  })

  it('Settings identifies the compact packaged live model and labels the large live preference development-only', () => {
    const settings = read('src/renderer/src/components/Settings.tsx')
    expect(settings).toMatch(/if \(!shouldUseBundledAsr\(import\.meta\.env\.PROD, bundled\)\)/)
    expect(settings).toMatch(/label="Prefer large live Whisper \(development\)"/)
    expect(settings).toMatch(/Live Whisper uses the compact Whisper base model in this build\./)
    expect(settings).toMatch(/The optional larger model\s+applies to imported recordings, not live transcription\./)
    expect(settings).not.toMatch(/label="Best transcription quality"/)
  })

  it('Best degrade reports qualityDegraded and discloses the live fallback without promising an import-model upgrade', () => {
    expect(read('src/renderer/src/lib/whisper.worker.ts')).toMatch(
      /qualityDegraded: requestedQuality === 'best' && engine !== 'webgpu'/
    )
    expect(read('src/renderer/src/App.tsx')).toMatch(/asrWebgpuFallbackAt/)
    const settings = read('src/renderer/src/components/Settings.tsx')
    expect(settings).toMatch(/A recent live session used Whisper base instead of the requested large model\./)
    expect(settings).toMatch(/Packaged builds use Whisper base for live transcription\./)
    expect(settings).toMatch(/The optional larger\s+download changes imported recordings only\./)
    expect(settings).not.toMatch(/Download the high-accuracy model/)
  })
})

describe('ASR quality ship — languages, switch, echo, meaning', () => {
  it('detects 60+ spoken languages from one shared list', () => {
    expect(LANGUAGE_NAMES.length).toBeGreaterThanOrEqual(60)
    expect(read('src/renderer/src/components/Settings.tsx')).toMatch(
      /import \{ LANGUAGE_OPTIONS \} from '@shared\/lang-id'/
    )
    expect(read('src/main/apple-speech.ts')).toMatch(/import \{ APPLE_LOCALES \} from '@shared\/lang-id'/)
  })

  it('echo silence is not an empty-run stall', () => {
    expect(read('src/renderer/src/lib/listen.ts')).toMatch(/if \(feedEmptyIsEcho\(res\)\)/)
    expect(read('src/main/index.ts')).toMatch(/if \(label\?\.echo\) return \{ text: '', echo: true \}/)
  })

  it('documents actual packaged models and RAM-based fresh setup, not the development-only quality switch (MQA-311)', () => {
    const doc = read('docs/asr/QUALITY.md')
    expect(doc).toMatch(/8 GiB or less[^\n]*Parakeet/i)
    expect(doc).toMatch(/more than 8 GiB[^\n]*Whisper/i)
    expect(doc).toMatch(/existing[^\n]*preferences[^\n]*preserved/i)
    expect(doc).toMatch(/packaged[^\n]*live[^\n]*Whisper base/i)
    expect(doc).toMatch(/larger[^\n]*imported recordings only/i)
    expect(doc).not.toMatch(/Default is \*\*Best\*\*|Fast is a Settings power option/)
    expect(doc).toMatch(/development-only/i)
    expect(doc).toMatch(/SWITCH_AFTER/)
    expect(doc).toMatch(/60\+/)
    const architecture = read('docs/asktoto-architecture.md')
    expect(architecture).toMatch(/packaged live Whisper uses[^\n]*Whisper base/i)
    expect(architecture).toMatch(/large-v3-turbo[^\n]*import-only/i)
  })
})
