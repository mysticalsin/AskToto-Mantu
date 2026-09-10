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
  it('rejects substantial partial text when the stream reports an error', async () => {
    const createStream = vi.fn((opts: { handlers: { onDelta: (d: string) => void; onError: (e: string) => void } }) => {
      opts.handlers.onDelta('x'.repeat(200))
      opts.handlers.onError('idle timeout')
      return { abort: () => {} }
    })

    await expect(
      runImportedRecap(
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
    ).rejects.toThrow(/idle timeout.*retry/i)
  })

  it('rejects text when the provider says the output token limit stopped completion', async () => {
    const createStream = vi.fn((opts: {
      handlers: {
        onDelta: (d: string) => void
        onDone: (usage: object, completion?: { status: 'complete' | 'incomplete'; reason?: string }) => void
      }
    }) => {
      opts.handlers.onDelta('## Overview\nA useful but truncated recap')
      opts.handlers.onDone({}, { status: 'incomplete', reason: 'length' })
      return { abort: () => {} }
    })

    await expect(
      runImportedRecap(
        { jobId: 'j2', lines: [{ name: 'Alex', speaker: 'unknown', text: 'we decided to ship', t: 1 }], mode: 'meeting' },
        {
          getSettings: () => settings(),
          getApiKey: () => 'sk-test',
          getAllowedProviders: () => null,
          providerBaseUrl: () => '',
          redactSecrets: (t) => t,
          createStream: createStream as never
        }
      )
    ).rejects.toThrow(/incomplete.*length/i)
  })

  it('sends the selected summary language without changing the cached prefix', async () => {
    const createStream = vi.fn((opts: {
      system: string
      systemParts?: { cachedPrefix: string; volatile: string }
      handlers: { onDelta: (d: string) => void; onDone: (usage: object) => void }
    }) => {
      expect(opts.system.startsWith(IMPORT_RECAP_SYSTEM_PREFIX)).toBe(true)
      expect(opts.system).toContain('Always respond in French')
      expect(opts.systemParts?.cachedPrefix).toBe(IMPORT_RECAP_SYSTEM_PREFIX)
      expect(opts.systemParts?.volatile).toContain('Always respond in French')
      opts.handlers.onDelta('## Overview\nLivraison approuvée.')
      opts.handlers.onDone({})
      return { abort: () => {} }
    })
    const recap = await runImportedRecap(
      { jobId: 'j3', lines: [{ name: 'Alex', speaker: 'unknown', text: 'we decided to ship', t: 1 }], mode: 'meeting' },
      {
        getSettings: () => settings({ outputLanguage: 'English', summaryLanguage: 'French' }),
        getApiKey: () => 'sk-test',
        getAllowedProviders: () => null,
        providerBaseUrl: () => '',
        redactSecrets: (t) => t,
        createStream: createStream as never
      }
    )
    expect(recap).toBe('## Overview\nLivraison approuvée.')
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
