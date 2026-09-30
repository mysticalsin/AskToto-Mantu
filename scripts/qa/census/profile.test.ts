import { describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { representativeSettings, writeRepresentativeProfile } from './profile.mjs'

function withProfile<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'metis-census-profile-'))
  try {
    return fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

describe('resource census representative profile generator', () => {
  it('is deterministic across fresh output directories', () => {
    const first = withProfile((root) => writeRepresentativeProfile(root).manifest.sha256)
    const second = withProfile((root) => writeRepresentativeProfile(root).manifest.sha256)

    expect(first).toBe(second)
    expect(first).toMatch(/^[a-f0-9]{64}$/)
  })

  it('writes 59 synthetic meeting transcripts and covers every one in the brain index', () => {
    withProfile((root) => {
      writeRepresentativeProfile(root)
      const meetingsRoot = join(root, 'meetings')
      const meetingFiles = readdirSync(meetingsRoot).filter((name) => name.endsWith('.md') && name !== 'index.md')
      const index = readJson(join(meetingsRoot, '.brain', 'index.json'))

      expect(meetingFiles).toHaveLength(59)
      expect(index.schema_version).toBe(2)
      expect(Object.keys(index.ingested).sort()).toEqual(meetingFiles.sort())
      for (const file of meetingFiles) {
        expect(index.ingested[file]).toMatchObject({ ok: true, attempts: 0 })
        expect(index.ingested[file].sourceVersion).toMatch(/^\d+:\d+$/)
        const text = readFileSync(join(meetingsRoot, file), 'utf8')
        const date = text.match(/^date: "([^"]+)"$/m)?.[1]
        const duration = Number(text.match(/^duration_min: (\d+)$/m)?.[1])
        expect(new Date(date ?? '').getTime()).toBeGreaterThanOrEqual(Date.UTC(2026, 5, 29, 13, 0, 0))
        expect(new Date(date ?? '').getTime()).toBeLessThan(Date.UTC(2026, 8, 27, 13, 0, 0))
        expect(duration).toBeGreaterThanOrEqual(5)
        expect(duration).toBeLessThanOrEqual(90)
        expect(text).toContain('mode: "meeting"')
        expect(text).toContain('## Full transcript')
        expect(text).not.toContain(root)
        expect(text).not.toContain('@')
      }
    })
  })

  it('keeps hosted-run settings armed for local LLM, brain, speaker ID, and Whisper', () => {
    const settings = representativeSettings('/tmp/metis-census-profile', 1)

    expect(settings).toMatchObject({
      overlayLayout: 'bar',
      asrEngine: 'whisper',
      speakerId: { enabled: true },
      localLlm: {
        enabled: true,
        modelId: 'qwen3.5-0.8b',
        useFor: { suggest: true, summary: true, vision: true },
        fallback: true
      },
      brainConsolidation: { enabled: true },
      routingMode: 'local'
    })
  })

  it('defaults to the bar layout and accepts the owner hide layout', () => {
    expect(representativeSettings('/tmp/metis-census-profile').overlayLayout).toBe('bar')
    expect(representativeSettings('/tmp/metis-census-profile', 1, { layout: 'hide' }).overlayLayout).toBe('hide')
    expect(() => representativeSettings('/tmp/metis-census-profile', 1, { layout: 'island' })).toThrow(/bar, hide/)

    withProfile((root) => {
      const profile = writeRepresentativeProfile(root, undefined, { layout: 'hide' })
      const persisted = readJson(join(root, 'settings.json'))
      expect(profile.manifest.layout).toBe('hide')
      expect(persisted.overlayLayout).toBe('hide')
    })
  })

  it('writes a content-free manifest with the approved field allowlist', () => {
    withProfile((root) => {
      const profile = writeRepresentativeProfile(root)
      const manifest = readJson(join(root, 'resource-census-profile.json'))

      expect(Object.keys(manifest).sort()).toEqual([
        'asrEngine',
        'brain',
        'datalessMeetings',
        'datalessReason',
        'layout',
        'localLlm',
        'meetingCount',
        'profileKind',
        'schemaVersion',
        'sha256',
        'speakerId',
        'totalTranscriptWords'
      ])
      expect(manifest).toEqual(profile.manifest)
      expect(manifest).toMatchObject({
        schemaVersion: 2,
        profileKind: 'representative-synthetic',
        meetingCount: 59,
        layout: 'bar',
        localLlm: { enabled: true, modelId: 'qwen3.5-0.8b' },
        brain: { enabled: true },
        speakerId: { enabled: true },
        asrEngine: 'whisper',
        datalessMeetings: 0,
        datalessReason: 'real dataless files need a cloud provider; measured in the owner soak (OD-36)'
      })
      expect(manifest.totalTranscriptWords).toBeGreaterThan(1000)
      expect(JSON.stringify(manifest)).not.toContain(root)
    })
  })
})
