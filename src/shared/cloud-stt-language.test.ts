import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveNova3LanguageQuery, resolveSonioxLanguageConfig } from './cloud-stt-language'

describe('cloud-stt-language — FR / auto (Nova + Soniox)', () => {
  it('auto → multi + detect_language; Soniox fr+en (never en-only)', () => {
    expect(resolveNova3LanguageQuery('auto')).toEqual({ language: 'multi', detect_language: true })
    const s = resolveSonioxLanguageConfig('auto')
    expect(s.language_hints).toEqual(['fr', 'en'])
    expect(s.autoDetect).toBe(true)
  })

  it('French → fr-CA; explicit Settings win', () => {
    expect(resolveNova3LanguageQuery('French')).toEqual({ language: 'fr-CA', detect_language: false })
    expect(resolveSonioxLanguageConfig('French')).toEqual({ language_hints: ['fr'], autoDetect: false })
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
