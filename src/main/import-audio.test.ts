import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  humanizeFilename,
  AUDIO_EXTENSIONS,
  audioPickerDialogOptions,
  offerAudioPaths,
  consumePickedAudio,
  MAX_SOURCE_BYTES
} from './import-audio'

function writeId3(path: string, body = 'audio'): void {
  writeFileSync(path, Buffer.concat([Buffer.from('ID3'), Buffer.from(body)]))
}

describe('audio picker options', () => {
  it('asks the native dialog for several files at once', () => {
    const opts = audioPickerDialogOptions()
    expect(opts.properties).toEqual(expect.arrayContaining(['openFile', 'multiSelections']))
  })
})

describe('offerAudioPaths', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('N readable files produce N tokens and never return a path', () => {
    dir = mkdtempSync(join(tmpdir(), 'metis-import-pick-'))
    const a = join(dir, 'standup.m4a')
    const b = join(dir, 'review.wav')
    writeId3(a)
    writeId3(b)
    const picked = offerAudioPaths([a, b])
    expect(picked.files).toHaveLength(2)
    expect(picked.token).toBe(picked.files![0].token)
    expect(JSON.stringify(picked)).not.toContain(dir)
    expect(consumePickedAudio(picked.files![0].token).name).toBe('standup.m4a')
    expect(consumePickedAudio(picked.files![1].token).name).toBe('review.wav')
  })

  it('skips a folder and still stages the rest, and names the 500 MB per-file cap', () => {
    dir = mkdtempSync(join(tmpdir(), 'metis-import-big-'))
    const ok = join(dir, 'ok.mp3')
    const folder = join(dir, 'not-a-file')
    writeId3(ok)
    mkdirSync(folder)
    const picked = offerAudioPaths([ok, folder])
    expect(picked.files).toHaveLength(1)
    expect(picked.files![0].name).toBe('ok.mp3')
    expect(picked.skipped).toEqual([
      expect.objectContaining({ name: 'not-a-file', error: expect.stringMatching(/not a folder/) })
    ])
    expect(MAX_SOURCE_BYTES).toBe(500 * 1024 * 1024)
    expect(readFileSync(join(__dirname, 'import-audio.ts'), 'utf8')).toMatch(
      /That file is larger than 500 MB\. Choose a smaller recording/
    )
  })
})

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
