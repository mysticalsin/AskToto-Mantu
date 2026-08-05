import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { extractZipBuffer } from './zip-extract.mjs'

// Both fixtures were written by bsdtar (libarchive 3.8.1) — an independent zip implementation, not this
// module — over the same tree: llama-b9957/{ggml.dll,llama-cli.exe,llama-server.exe,zz/evil.txt}. They
// mirror the shape of the real llama.cpp win assets, including bsdtar's streaming data descriptor, which
// zeroes the sizes and CRC in every LOCAL header (see the local-vs-central note in zip-extract.mjs).
const FIXTURE_DEFLATE =
  'UEsDBBQAAAAAACZmBV0AAAAAAAAAAAAAAAAMACAAbGxhbWEtYjk5NTcvdXgLAAEEAAAAAAQAAAAAVVQNAAeIaXNqiGlzaohpc2pQ' +
  'SwMEFAAIAAgAJmYFXQAAAAAAAAAAAAAAABQAIABsbGFtYS1iOTk1Ny9nZ21sLmRsbHV4CwABBAAAAAAEAAAAAFVUDQAHiGlzaohp' +
  'c2qIaXNq841KT8/NUSjOSCxKTVHIyUxSoDYfAFBLBwhKEsFqFgAAAGIAAABQSwMEFAAIAAgAJmYFXQAAAAAAAAAAAAAAABkAIABs' +
  'bGFtYS1iOTk1Ny9sbGFtYS1jbGkuZXhldXgLAAEEAAAAAAQAAAAAVVQNAAeIaXNqiGlzaohpc2rzjVJIySxOTixKSU1RSK1IzC3I' +
  'SVVIysxLLKoEAFBLBwiXe+PoHQAAABsAAABQSwMEFAAIAAgAJmYFXQAAAAAAAAAAAAAAABwAIABsbGFtYS1iOTk1Ny9sbGFtYS1z' +
  'ZXJ2ZXIuZXhldXgLAAEEAAAAAAQAAAAAVVQNAAeIaXNqiGlzaohpc2rzjcrJScxN1C1OLSpLLVIoSKzMyU9MURiEggBQSwcIJpub' +
  'RRsAAACqAAAAUEsDBBQAAAAAACZmBV0AAAAAAAAAAAAAAAAPACAAbGxhbWEtYjk5NTcvenovdXgLAAEEAAAAAAQAAAAAVVQNAAeI' +
  'aXNqiGlzaohpc2pQSwMEFAAIAAgAJmYFXQAAAAAAAAAAAAAAABcAIABsbGFtYS1iOTk1Ny96ei9ldmlsLnR4dHV4CwABBAAAAAAE' +
  'AAAAAFVUDQAHiGlzaohpc2qIaXNqKylKLEstKk7MUSgoyk9KBQBQSwcIdWd2FBEAAAAPAAAAUEsBAhQDFAAAAAAAJmYFXQAAAAAA' +
  'AAAAAAAAAAwAGAAAAAAAAAAAAP9BAAAAAGxsYW1hLWI5OTU3L3V4CwABBAAAAAAEAAAAAFVUBQABiGlzalBLAQIUAxQACAAIACZm' +
  'BV1KEsFqFgAAAGIAAAAUABgAAAAAAAAAAAC2gUoAAABsbGFtYS1iOTk1Ny9nZ21sLmRsbHV4CwABBAAAAAAEAAAAAFVUBQABiGlz' +
  'alBLAQIUAxQACAAIACZmBV2Xe+PoHQAAABsAAAAZABgAAAAAAAAAAAD/gcIAAABsbGFtYS1iOTk1Ny9sbGFtYS1jbGkuZXhldXgL' +
  'AAEEAAAAAAQAAAAAVVQFAAGIaXNqUEsBAhQDFAAIAAgAJmYFXSabm0UbAAAAqgAAABwAGAAAAAAAAAAAAP+BRgEAAGxsYW1hLWI5' +
  'OTU3L2xsYW1hLXNlcnZlci5leGV1eAsAAQQAAAAABAAAAABVVAUAAYhpc2pQSwECFAMUAAAAAAAmZgVdAAAAAAAAAAAAAAAADwAY' +
  'AAAAAAAAAAAA/0HLAQAAbGxhbWEtYjk5NTcvenovdXgLAAEEAAAAAAQAAAAAVVQFAAGIaXNqUEsBAhQDFAAIAAgAJmYFXXVndhQR' +
  'AAAADwAAABcAGAAAAAAAAAAAALaBGAIAAGxsYW1hLWI5OTU3L3p6L2V2aWwudHh0dXgLAAEEAAAAAAQAAAAAVVQFAAGIaXNqUEsF' +
  'BgAAAAAGAAYAHwIAAI4CAAAAAA=='

// Same tree, written with `--options zip:compression=store` so every entry is METHOD_STORE (0) instead
// of deflate (8) — the other half of the compression branch, and the fixture the CRC test corrupts.
const FIXTURE_STORE =
  'UEsDBBQAAAAAACZmBV0AAAAAAAAAAAAAAAAMACAAbGxhbWEtYjk5NTcvdXgLAAEEAAAAAAQAAAAAVVQNAAeIaXNqmmlzaohpc2pQ' +
  'SwMECgAIAAAAJmYFXQAAAAAAAAAAAAAAABQAIABsbGFtYS1iOTk1Ny9nZ21sLmRsbHV4CwABBAAAAAAEAAAAAFVUDQAHiGlzaohp' +
  'c2qIaXNqTVpnZ21sIHNoYXJlZCBsaWIgZ2dtbCBzaGFyZWQgbGliIGdnbWwgc2hhcmVkIGxpYiBnZ21sIHNoYXJlZCBsaWIgZ2dt' +
  'bCBzaGFyZWQgbGliIGdnbWwgc2hhcmVkIGxpYiBQSwcIShLBamIAAABiAAAAUEsDBAoACAAAACZmBV0AAAAAAAAAAAAAAAAZACAA' +
  'bGxhbWEtYjk5NTcvbGxhbWEtY2xpLmV4ZXV4CwABBAAAAAAEAAAAAFVUDQAHiGlzaohpc2qIaXNqTVogZGlzY2FyZGVkIGV4YW1w' +
  'bGUgYmluYXJ5UEsHCJd74+gbAAAAGwAAAFBLAwQKAAgAAAAmZgVdAAAAAAAAAAAAAAAAHAAgAGxsYW1hLWI5OTU3L2xsYW1hLXNl' +
  'cnZlci5leGV1eAsAAQQAAAAABAAAAABVVA0AB4hpc2qIaXNqiGlzak1abGxhbWEtc2VydmVyIHBheWxvYWQgbGxhbWEtc2VydmVy' +
  'IHBheWxvYWQgbGxhbWEtc2VydmVyIHBheWxvYWQgbGxhbWEtc2VydmVyIHBheWxvYWQgbGxhbWEtc2VydmVyIHBheWxvYWQgbGxh' +
  'bWEtc2VydmVyIHBheWxvYWQgbGxhbWEtc2VydmVyIHBheWxvYWQgbGxhbWEtc2VydmVyIHBheWxvYWQgUEsHCCabm0WqAAAAqgAA' +
  'AFBLAwQUAAAAAAAmZgVdAAAAAAAAAAAAAAAADwAgAGxsYW1hLWI5OTU3L3p6L3V4CwABBAAAAAAEAAAAAFVUDQAHiGlzapppc2qI' +
  'aXNqUEsDBAoACAAAACZmBV0AAAAAAAAAAAAAAAAXACAAbGxhbWEtYjk5NTcvenovZXZpbC50eHR1eAsAAQQAAAAABAAAAABVVA0A' +
  'B4hpc2qIaXNqiGlzanRyYXZlcnNhbCBwcm9iZVBLBwh1Z3YUDwAAAA8AAABQSwECFAMUAAAAAAAmZgVdAAAAAAAAAAAAAAAADAAY' +
  'AAAAAAAAAAAA/0EAAAAAbGxhbWEtYjk5NTcvdXgLAAEEAAAAAAQAAAAAVVQFAAGIaXNqUEsBAgoDCgAIAAAAJmYFXUoSwWpiAAAA' +
  'YgAAABQAGAAAAAAAAAAAALaBSgAAAGxsYW1hLWI5OTU3L2dnbWwuZGxsdXgLAAEEAAAAAAQAAAAAVVQFAAGIaXNqUEsBAgoDCgAI' +
  'AAAAJmYFXZd74+gbAAAAGwAAABkAGAAAAAAAAAAAAP+BDgEAAGxsYW1hLWI5OTU3L2xsYW1hLWNsaS5leGV1eAsAAQQAAAAABAAA' +
  'AABVVAUAAYhpc2pQSwECCgMKAAgAAAAmZgVdJpubRaoAAACqAAAAHAAYAAAAAAAAAAAA/4GQAQAAbGxhbWEtYjk5NTcvbGxhbWEt' +
  'c2VydmVyLmV4ZXV4CwABBAAAAAAEAAAAAFVUBQABiGlzalBLAQIUAxQAAAAAACZmBV0AAAAAAAAAAAAAAAAPABgAAAAAAAAAAAD/' +
  'QaQCAABsbGFtYS1iOTk1Ny96ei91eAsAAQQAAAAABAAAAABVVAUAAYhpc2pQSwECCgMKAAgAAAAmZgVddWd2FA8AAAAPAAAAFwAY' +
  'AAAAAAAAAAAAtoHxAgAAbGxhbWEtYjk5NTcvenovZXZpbC50eHR1eAsAAQQAAAAABAAAAABVVAUAAYhpc2pQSwUGAAAAAAYABgAf' +
  'AgAAZQMAAAAA'

const EXPECTED_CONTENTS: Record<string, string> = {
  'llama-b9957/ggml.dll': 'MZ' + 'ggml shared lib '.repeat(6),
  'llama-b9957/llama-cli.exe': 'MZ discarded example binary',
  'llama-b9957/llama-server.exe': 'MZ' + 'llama-server payload '.repeat(8),
  'llama-b9957/zz/evil.txt': 'traversal probe'
}

function listFiles(root: string, base = root, out: string[] = []): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) listFiles(path, base, out)
    else out.push(relative(base, path).replace(/\\/g, '/'))
  }
  return out.sort()
}

let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'metis-zip-extract-'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('in-process zip extraction', () => {
  it('unpacks every deflated entry with byte-exact contents', () => {
    const extracted = extractZipBuffer(Buffer.from(FIXTURE_DEFLATE, 'base64'), scratch)

    expect(listFiles(scratch)).toEqual(Object.keys(EXPECTED_CONTENTS).sort())
    expect(extracted).toHaveLength(Object.keys(EXPECTED_CONTENTS).length)
    for (const [name, contents] of Object.entries(EXPECTED_CONTENTS)) {
      expect(readFileSync(join(scratch, name), 'utf8')).toBe(contents)
      expect(statSync(join(scratch, name)).size).toBe(contents.length)
    }
  })

  it('unpacks stored (uncompressed) entries too', () => {
    extractZipBuffer(Buffer.from(FIXTURE_STORE, 'base64'), scratch)

    expect(listFiles(scratch)).toEqual(Object.keys(EXPECTED_CONTENTS).sort())
    for (const [name, contents] of Object.entries(EXPECTED_CONTENTS)) {
      expect(readFileSync(join(scratch, name), 'utf8')).toBe(contents)
    }
  })

  it('takes sizes from the central directory when the local headers use a data descriptor', () => {
    // Guards the design decision, not just the outcome: bsdtar zeroes size/CRC in the local header and
    // defers them to a trailing descriptor, so a forward scan of local headers would extract 0 bytes.
    const buf = Buffer.from(FIXTURE_DEFLATE, 'base64')
    const firstFileLocalHeader = buf.indexOf(Buffer.from('llama-b9957/ggml.dll')) - 30
    expect(buf.readUInt16LE(firstFileLocalHeader + 6) & 0x8).toBe(0x8) // data-descriptor flag set
    expect(buf.readUInt32LE(firstFileLocalHeader + 22)).toBe(0) // local uncompressed-size field zeroed

    extractZipBuffer(buf, scratch)

    expect(readFileSync(join(scratch, 'llama-b9957/ggml.dll'), 'utf8')).toBe(
      EXPECTED_CONTENTS['llama-b9957/ggml.dll']
    )
  })

  it('refuses an entry whose path escapes the destination directory', () => {
    // Rewrite "llama-b9957/zz/evil.txt" to an escaping path of the SAME byte length in every header, so
    // every recorded offset in the archive still holds.
    const escaping = '../../../../../evil.txt'
    const original = 'llama-b9957/zz/evil.txt'
    expect(escaping).toHaveLength(original.length)
    const buf = Buffer.from(FIXTURE_DEFLATE, 'base64')
    let at = buf.indexOf(Buffer.from(original))
    expect(at).toBeGreaterThan(0)
    while (at >= 0) {
      buf.write(escaping, at, 'latin1')
      at = buf.indexOf(Buffer.from(original), at + 1)
    }

    expect(() => extractZipBuffer(buf, join(scratch, 'dest'))).toThrow(/escapes destination directory/)
  })

  it('rejects a corrupted entry via its CRC instead of writing bad bytes', () => {
    const buf = Buffer.from(FIXTURE_STORE, 'base64')
    const payloadAt = buf.indexOf(Buffer.from('traversal probe'))
    buf[payloadAt] = buf[payloadAt] ^ 0xff

    expect(() => extractZipBuffer(buf, scratch)).toThrow(/CRC mismatch/)
  })

  it('rejects an encrypted entry rather than writing ciphertext to disk', () => {
    const buf = Buffer.from(FIXTURE_STORE, 'base64')
    const central = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    buf.writeUInt16LE(buf.readUInt16LE(central + 8) | 0x1, central + 8)

    expect(() => extractZipBuffer(buf, scratch)).toThrow(/is encrypted/)
  })

  it('reports a file that is not a zip instead of silently extracting nothing', () => {
    expect(() => extractZipBuffer(Buffer.from('not an archive at all'), scratch)).toThrow(
      /end-of-central-directory record not found/
    )
  })
})
