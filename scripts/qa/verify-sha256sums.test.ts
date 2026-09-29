import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hashDirectory, parseSha256Sums, verifyArtifacts } from './verify-sha256sums.mjs'

const digest = (text: string): string => createHash('sha256').update(text).digest('hex')

describe('verify-sha256sums', () => {
  const good = digest('dmg-bytes')

  it('accepts artifacts whose digests match the published sums, in text or binary mode', () => {
    const sums = `${good}  Metis-1.9.6.dmg\n${digest('exe')} *Metis-Setup-1.9.6.exe\n`
    expect(
      verifyArtifacts(sums, [
        { name: 'Metis-1.9.6.dmg', sha256: good },
        { name: 'Metis-Setup-1.9.6.exe', sha256: digest('exe') }
      ])
    ).toEqual(['Metis-1.9.6.dmg', 'Metis-Setup-1.9.6.exe'])
  })

  it('fails on a digest mismatch', () => {
    expect(() => verifyArtifacts(`${good}  Metis-1.9.6.dmg\n`, [{ name: 'Metis-1.9.6.dmg', sha256: digest('tampered') }])).toThrow(
      /digest mismatch/
    )
  })

  it('fails when the artifact is not listed or nothing was downloaded', () => {
    expect(() => verifyArtifacts(`${good}  other.dmg\n`, [{ name: 'Metis-1.9.6.dmg', sha256: good }])).toThrow(/not listed/)
    expect(() => verifyArtifacts(`${good}  other.dmg\n`, [])).toThrow(/No artifacts/)
  })

  it('rejects malformed sums lines instead of ignoring them', () => {
    expect(() => parseSha256Sums('not-a-digest  file.dmg\n')).toThrow(/Unparseable/)
  })

  it('hashes the files in a directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sums-'))
    try {
      writeFileSync(join(dir, 'a.bin'), 'x')
      mkdirSync(join(dir, 'sub'))
      expect(hashDirectory(dir)).toEqual([{ name: 'a.bin', sha256: digest('x') }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
