import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isAudioOrVideoMagic, sniffMediaFile } from './import-magic'

function bytes(...hex: number[]): Uint8Array {
  return Uint8Array.from(hex)
}

describe('isAudioOrVideoMagic', () => {
  it('admits common audio and video containers', () => {
    const riff = Buffer.alloc(12)
    riff.write('RIFF', 0)
    riff.write('WAVE', 8)
    expect(isAudioOrVideoMagic(riff)).toBe(true)

    const ftyp = Buffer.alloc(8)
    ftyp.write('ftyp', 4)
    expect(isAudioOrVideoMagic(ftyp)).toBe(true)

    expect(isAudioOrVideoMagic(Buffer.from('ID3\x04\x00'))).toBe(true)
    expect(isAudioOrVideoMagic(Buffer.from('fLaC'))).toBe(true)
    expect(isAudioOrVideoMagic(Buffer.from('OggS'))).toBe(true)
    expect(isAudioOrVideoMagic(Buffer.from('#!AMR\n'))).toBe(true)
    expect(isAudioOrVideoMagic(bytes(0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0))).toBe(true)
    expect(isAudioOrVideoMagic(bytes(0xff, 0xfb, 0x90, 0x00))).toBe(true)
  })

  it('refuses executables, HTML, PDF, and empty blobs', () => {
    expect(isAudioOrVideoMagic(Buffer.from('MZ\x90\x00'))).toBe(false)
    expect(isAudioOrVideoMagic(Buffer.from('\x7fELF'))).toBe(false)
    expect(isAudioOrVideoMagic(Buffer.from('%PDF-1.7'))).toBe(false)
    expect(isAudioOrVideoMagic(Buffer.from('<!DOCTYPE html>'))).toBe(false)
    expect(isAudioOrVideoMagic(Buffer.from('<script>'))).toBe(false)
    expect(isAudioOrVideoMagic(Buffer.from(''))).toBe(false)
  })
})

describe('sniffMediaFile', () => {
  it('reads the on-disk header, not the extension', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'import-magic-'))
    try {
      const wav = join(dir, 'notes.exe')
      const riff = Buffer.alloc(12)
      riff.write('RIFF', 0)
      riff.write('WAVE', 8)
      await writeFile(wav, riff)
      expect(sniffMediaFile(wav)).toBe(true)

      const html = join(dir, 'interview.mp3')
      await writeFile(html, '<!DOCTYPE html><script>alert(1)</script>')
      expect(sniffMediaFile(html)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
