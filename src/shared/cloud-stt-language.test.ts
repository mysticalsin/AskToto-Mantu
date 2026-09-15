import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  CORE_SONIOX_AUTO_HINTS,
  resolveNova3LanguageQuery,
  resolveNova3LanguageQueryPinned,
  resolveSonioxLanguageConfig,
  resolveSonioxLanguageConfigPinned
} from './cloud-stt-language'

describe('cloud-stt-language — multilingual + auto (Nova + Soniox)', () => {
  it('auto → multi + detect_language; Soniox fr+en+es+pt+it (never en-only / never fr-only)', () => {
    expect(resolveNova3LanguageQuery('auto')).toEqual({ language: 'multi', detect_language: true })
    const s = resolveSonioxLanguageConfig('auto')
    expect(s.language_hints).toEqual(['fr', 'en', 'es', 'pt', 'it'])
    expect(s.language_hints).toEqual([...CORE_SONIOX_AUTO_HINTS])
    expect(s.autoDetect).toBe(true)
    expect(s.language_hints).not.toEqual(['en'])
    expect(s.language_hints).not.toEqual(['fr', 'en'])
  })

  it('resolves each core locale (FR/EN/ES/PT/IT) + auto', () => {
    const cases: Array<[string, string]> = [
      ['French', 'fr-CA'],
      ['English', 'en'],
      ['Spanish', 'es'],
      ['Portuguese', 'pt'],
      ['Italian', 'it'],
      ['auto', 'multi']
    ]
    for (const [input, novaLang] of cases) {
      const nova = resolveNova3LanguageQuery(input)
      expect(nova.language).toBe(novaLang)
      if (input === 'auto') {
        expect(nova.detect_language).toBe(true)
        expect(resolveSonioxLanguageConfig(input).language_hints).toEqual([...CORE_SONIOX_AUTO_HINTS])
      } else {
        expect(nova.detect_language).toBe(false)
        const primary = novaLang.split('-')[0]!
        expect(resolveSonioxLanguageConfig(input)).toEqual({
          language_hints: [primary === 'fr' ? 'fr' : primary],
          autoDetect: false
        })
      }
    }
  })

  it('French → fr-CA; explicit Settings win', () => {
    expect(resolveNova3LanguageQuery('French')).toEqual({ language: 'fr-CA', detect_language: false })
    expect(resolveSonioxLanguageConfig('French')).toEqual({ language_hints: ['fr'], autoDetect: false })
  })

  it('sticky pin on auto follows mid-meeting language; explicit Settings ignore pin', () => {
    expect(resolveNova3LanguageQueryPinned('auto', 'Spanish')).toEqual({
      language: 'es',
      detect_language: false
    })
    expect(resolveSonioxLanguageConfigPinned('auto', 'Portuguese')).toEqual({
      language_hints: ['pt'],
      autoDetect: false
    })
    expect(resolveNova3LanguageQueryPinned('French', 'Spanish')).toEqual({
      language: 'fr-CA',
      detect_language: false
    })
    expect(resolveSonioxLanguageConfigPinned('Italian', 'English')).toEqual({
      language_hints: ['it'],
      autoDetect: false
    })
  })

  it('FR asr-fixture clips map lang=fr → fr-CA for Nova URL wiring', () => {
    const manifestPath = join(__dirname, '../../scripts/qa/asr-fixtures/manifest.json')
    expect(existsSync(manifestPath)).toBe(true)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      clips: Array<{ id: string; lang: string; expected: string }>
    }
    const fr = manifest.clips.filter((c) => c.lang === 'fr')
    expect(fr.length).toBeGreaterThanOrEqual(1)
    for (const clip of fr) {
      expect(resolveNova3LanguageQuery(clip.lang).language).toBe('fr-CA')
      expect(/[àâäéèêëïîôùûüçœ]|bonjour|nous|contrat|montant|euros/i.test(clip.expected)).toBe(true)
    }
  })
})
