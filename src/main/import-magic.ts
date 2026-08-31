import { closeSync, openSync, readSync } from 'node:fs'

const HEADER = 16

/** True when the first bytes look like an audio or video container ffmpeg is allowed to decode. */
export function isAudioOrVideoMagic(buf: Uint8Array): boolean {
  if (buf.length < 3) return false
  const ascii = (start: number, n: number): string =>
    String.fromCharCode(...buf.subarray(start, start + n))

  if (ascii(0, 4) === 'RIFF' && buf.length >= 12 && ascii(8, 4) === 'WAVE') return true
  if (ascii(0, 4) === 'FORM' && buf.length >= 12 && (ascii(8, 4) === 'AIFF' || ascii(8, 4) === 'AIFC')) {
    return true
  }
  if (ascii(0, 3) === 'ID3') return true
  if (ascii(0, 4) === 'fLaC') return true
  if (ascii(0, 4) === 'OggS') return true
  if (ascii(0, 4) === '#!AM') return true
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return true // EBML (webm/mkv)
  if (
    buf[0] === 0x30 &&
    buf[1] === 0x26 &&
    buf[2] === 0xb2 &&
    buf[3] === 0x75
  ) {
    return true // ASF / WMA
  }
  if (buf.length >= 8 && ascii(4, 4) === 'ftyp') return true // mp4/m4a/mov/3gp
  // MPEG ADTS / MP3 frame sync
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true
  return false
}

export function sniffMediaFile(path: string): boolean {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(HEADER)
    const n = readSync(fd, buf, 0, HEADER, 0)
    return isAudioOrVideoMagic(buf.subarray(0, n))
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* already closed */
      }
    }
  }
}

export const IMPORT_NOT_MEDIA = 'That file is not an audio or video recording.'
