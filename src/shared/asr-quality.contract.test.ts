import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, SettingsSchema } from './ipc'
import { LANGUAGE_NAMES } from './lang-id'

const root = process.cwd()
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n')

describe('ASR quality ship — Best default, Fast is a power option', () => {
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

  it('Settings copy names Fast as a power option and never presents silent Fast as Best', () => {
    const settings = read('src/renderer/src/components/Settings.tsx')
    expect(settings).toMatch(/Fast is (a (Settings )?|the )power option/)
    expect(settings).toMatch(/never a silent Fast with a Best label|Fast is active/)
    expect(settings).not.toMatch(/On and Off currently use the same on-device model/)
  })

  it('Best degrade reports qualityDegraded and a Settings path', () => {
    expect(read('src/renderer/src/lib/whisper.worker.ts')).toMatch(
      /qualityDegraded: requestedQuality === 'best' && engine !== 'webgpu'/
    )
    expect(read('src/renderer/src/App.tsx')).toMatch(/asrWebgpuFallbackAt/)
    expect(read('src/renderer/src/components/Settings.tsx')).toMatch(
      /Download the high-accuracy (Whisper )?model/
    )
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

  it('QUALITY.md exists and locks Best as the default before Settings copy', () => {
    const doc = read('docs/asr/QUALITY.md')
    expect(doc).toMatch(/Default quality request is \*\*Best\*\*|Default is \*\*Best\*\*/)
    expect(doc).toMatch(/Fast is a Settings power option/)
    expect(doc).toMatch(/SWITCH_AFTER/)
    expect(doc).toMatch(/60\+/)
  })
})

describe('ASR quality ship — 1.9.0 multi-speaker + efficient engines', () => {
  it('QUALITY.md steers Parakeet-first and documents multi-speaker naming', () => {
    const doc = read('docs/asr/QUALITY.md')
    expect(doc).toMatch(/\*\*Parakeet\*\*.*\(default\)/)
    expect(doc).toMatch(/Multi-speaker \(1\.9\.0\)/)
    expect(doc).toMatch(/Speaker N/)
    expect(doc).toMatch(/voiceprint/i)
  })

  it('live stop + save finalize remaps Speaker N before disk', () => {
    expect(read('src/renderer/src/lib/listen.ts')).toMatch(/speakerFinalize/)
    expect(read('src/main/index.ts')).toMatch(/remapTranscriptSpeakerNames/)
    expect(read('src/main/index.ts')).toMatch(/finalizeSession/)
  })

  it('Review can promote a cluster into a durable voiceprint', () => {
    expect(read('src/renderer/src/components/Review.tsx')).toMatch(/onRenameSpeaker/)
    expect(read('src/renderer/src/App.tsx')).toMatch(/speakerPromote/)
    expect(read('src/main/speaker-id.ts')).toMatch(/promoteCluster/)
  })

  it('Settings keeps Speaker ID light and lists saved voiceprints', () => {
    const settings = read('src/renderer/src/components/Settings.tsx')
    expect(settings).toMatch(/Speaker identification \(beta\)/)
    expect(settings).toMatch(/~30 MB model/)
    expect(settings).toMatch(/SpeakerProfilesPanel/)
    expect(settings).toMatch(/speakerProfilesList/)
  })
})
