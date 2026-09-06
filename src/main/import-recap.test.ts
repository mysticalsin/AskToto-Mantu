import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '@shared/ipc'
import {
  IMPORT_RECAP_CACHE_KEY,
  IMPORT_RECAP_MAX_ATTEMPTS,
  IMPORT_RECAP_SYSTEM_PREFIX,
  IMPORT_RECAP_TIER,
  importedTranscriptText,
  importRecapSystem,
  pickImportRecapCandidates,
  runImportedRecap
} from './import-recap'

function settings(partial: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    provider: 'anthropic',
    providerModels: { ...DEFAULT_SETTINGS.providerModels, anthropic: 'claude-sonnet-4-6', openai: 'gpt-4.1' },
    redactSensitive: false,
    ...partial
  }
}

describe('import recap prefix and tier', () => {
  it('keeps a byte-stable cached system prefix with no Date.now', () => {
    expect(IMPORT_RECAP_SYSTEM_PREFIX.includes('Date.now')).toBe(false)
    expect(IMPORT_RECAP_SYSTEM_PREFIX).not.toMatch(/\d{13}/)
    expect(importRecapSystem(true)).toBe(IMPORT_RECAP_SYSTEM_PREFIX + importRecapSystem(true).slice(IMPORT_RECAP_SYSTEM_PREFIX.length))
    expect(importRecapSystem(false)).toBe(importRecapSystem(false))
    expect(importRecapSystem(true)).not.toBe(importRecapSystem(false))
    const a = IMPORT_RECAP_SYSTEM_PREFIX
    const b = IMPORT_RECAP_SYSTEM_PREFIX
    expect(a).toBe(b)
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
  })

  it('uses the summary/base tier, not think', () => {
    expect(IMPORT_RECAP_TIER).toBe('base')
    expect(IMPORT_RECAP_MAX_ATTEMPTS).toBe(3)
    expect(IMPORT_RECAP_CACHE_KEY).toBe('metis-import-recap-v1')
  })

  it('formats diarized lines with the speaker name', () => {
    expect(
      importedTranscriptText([
        { name: 'Jane Doe', text: 'ship Friday' },
        { name: '', text: 'agreed' }
      ])
    ).toBe('Jane Doe: ship Friday\nSPEAKER: agreed')
  })
})

describe('pickImportRecapCandidates', () => {
  const gate = {
    getApiKey: (p: string) => (p === 'anthropic' ? 'sk-test' : ''),
    providerBaseUrl: () => '',
    getAllowedProviders: () => null
  }

  it('prefers a connected API and skips local unless redact or no API', () => {
    expect(pickImportRecapCandidates(settings(), gate)[0]).toBe('anthropic')
    expect(pickImportRecapCandidates(settings(), gate)).not.toContain('local')
    expect(pickImportRecapCandidates(settings({ redactSensitive: true }), gate)).not.toContain('anthropic')
    const noApi = pickImportRecapCandidates(settings({ provider: 'openai' }), { ...gate, getApiKey: () => '' })
    expect(noApi).not.toContain('anthropic')
    expect(noApi).not.toContain('openai')
  })
})

describe('runImportedRecap critical path', () => {
  it('does not polish; streams at base tier with a cached prefix and keeps >=200 trailing chars', async () => {
    const createStream = vi.fn((opts: { system: string; reasoningEffort?: string; handlers: { onDelta: (d: string) => void; onError: (e: string) => void } }) => {
      expect(opts.system.startsWith(IMPORT_RECAP_SYSTEM_PREFIX)).toBe(true)
      opts.handlers.onDelta('x'.repeat(200))
      opts.handlers.onError('idle timeout')
      return { abort: () => {} }
    })
    const recap = await runImportedRecap(
      { jobId: 'j1', lines: [{ name: 'Alex', speaker: 'unknown', text: 'we decided to ship', t: 1 }], mode: 'meeting' },
      {
        getSettings: () => settings(),
        getApiKey: () => 'sk-test',
        getAllowedProviders: () => null,
        providerBaseUrl: () => '',
        redactSecrets: (t) => t,
        createStream: createStream as never
      }
    )
    expect(recap?.length).toBeGreaterThanOrEqual(200)
    expect(createStream).toHaveBeenCalled()
    const arg = createStream.mock.calls[0][0] as { promptCacheKey?: string; systemCacheTtl?: string; reasoningEffort?: unknown }
    expect(arg.promptCacheKey).toBe(IMPORT_RECAP_CACHE_KEY)
    expect(arg.systemCacheTtl).toBe('1h')
  })
})

describe('import recap is not polish-first', () => {
  it('import-jobs finalize recaps before any polish pass', () => {
    const src = readFileSync(join(__dirname, 'import-jobs.ts'), 'utf8')
    const finalize = src.slice(src.indexOf('private async finalize'), src.indexOf('async failDecoder'))
    expect(finalize.indexOf('generateRecap')).toBeGreaterThan(-1)
    expect(finalize.indexOf('generateRecap')).toBeLessThan(finalize.indexOf('if (this.deps.polish)'))
    expect(src).toMatch(/Polish is not on the import critical path/)
  })

  it('index.ts does not wire polish on import jobs', () => {
    const src = readFileSync(join(__dirname, 'index.ts'), 'utf8')
    const init = src.slice(src.indexOf('function initializeImportJobs'), src.indexOf('function loadDotEnv'))
    expect(init).toMatch(/Polish is skipped on import/)
    expect(init).not.toMatch(/polish:\s*runImportPolish/)
    expect(init).toMatch(/generateRecap:\s*runImportedRecap/)
    expect(init).toMatch(/runIntelligenceIndex\('import-idle'\)/)
  })
})
