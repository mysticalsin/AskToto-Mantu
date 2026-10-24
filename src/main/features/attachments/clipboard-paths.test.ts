import { describe, expect, it } from 'vitest'
import { pathsFromClipboardFormats } from './clipboard-paths'

describe('clipboard file paths (G54)', () => {
  it('reads macOS file URLs, decoding them', () => {
    const read = (f: string) => Buffer.from(f === 'public.file-url' ? 'file:///Users/o/My%20Notes.md\u0000' : '')
    expect(pathsFromClipboardFormats('darwin', read)).toEqual(['/Users/o/My Notes.md'])
  })
  it('reads the Windows wide-char list', () => {
    const read = (f: string) =>
      Buffer.from(f === 'FileNameW' ? 'C:\\a\\b.txt\u0000C:\\a\\c.txt\u0000\u0000' : '', 'utf16le')
    expect(pathsFromClipboardFormats('win32', read)).toEqual(['C:\\a\\b.txt', 'C:\\a\\c.txt'])
  })
  it('plain text on the clipboard yields no paths (so plain paste stays text)', () => {
    expect(pathsFromClipboardFormats('darwin', () => Buffer.from(''))).toEqual([])
    expect(pathsFromClipboardFormats('darwin', () => Buffer.from('just some words'))).toEqual([])
  })
  it('a malformed read never throws', () => {
    expect(
      pathsFromClipboardFormats('darwin', () => {
        throw new Error('nope')
      })
    ).toEqual([])
  })
})
