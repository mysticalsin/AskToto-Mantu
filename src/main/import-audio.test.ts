import { describe, it, expect } from 'vitest'
import { humanizeFilename, AUDIO_EXTENSIONS } from './import-audio'

describe('AUDIO_EXTENSIONS picker filter', () => {
  it("includes macOS/OBS recorder containers (mov/m4v/mkv) — QuickTime's default output was invisible in the picker before 2026-08-04", () => {
    for (const ext of ['mov', 'm4v', 'mkv', 'mp4', 'mp3', 'm4a', 'wav']) {
      expect(AUDIO_EXTENSIONS).toContain(ext)
    }
  })
})

describe('humanizeFilename', () => {
  it('strips the extension and humanizes dashes/underscores', () => {
    expect(humanizeFilename('q3-budget_review.wav')).toBe('Q3 Budget Review')
  })

  it('collapses repeated separators and surrounding whitespace', () => {
    expect(humanizeFilename('  weekly__sync--notes.mp3 ')).toBe('Weekly Sync Notes')
  })

  it('preserves further capitalization (e.g. an acronym) while capitalizing the first letter', () => {
    expect(humanizeFilename('NASA-briefing.m4a')).toBe('NASA Briefing')
  })

  it('falls back to a generic title for an empty or separators-only name', () => {
    expect(humanizeFilename('____.wav')).toBe('Imported audio')
    expect(humanizeFilename('.wav')).toBe('Imported audio')
  })

  it('handles a filename with no extension', () => {
    expect(humanizeFilename('standup-notes')).toBe('Standup Notes')
  })
})
