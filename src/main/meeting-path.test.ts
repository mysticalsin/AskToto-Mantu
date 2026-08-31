import { describe, expect, it } from 'vitest'
import { safeMeetingBasename } from './meeting-path'

describe('safeMeetingBasename', () => {
  it('accepts a meeting .md basename', () => {
    expect(safeMeetingBasename('2026-08-31-standup.md')).toBe('2026-08-31-standup.md')
  })

  it('strips directory prefixes so traversal cannot leave the meetings folder', () => {
    expect(safeMeetingBasename('../../etc/passwd.md')).toBe('passwd.md')
    expect(safeMeetingBasename('C:\\\\Users\\\\x\\\\secret.md')).toBe('secret.md')
    expect(safeMeetingBasename('/tmp/meetings/../notes.md')).toBe('notes.md')
  })

  it('refuses bookkeeping files, non-markdown, and empty names', () => {
    for (const bad of ['index.md', 'README.md', 'notes.txt', '', null, undefined, '.', '..']) {
      expect(safeMeetingBasename(bad)).toBeNull()
    }
  })
})
