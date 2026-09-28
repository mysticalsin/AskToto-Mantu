import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { selectCandidateInstaller } from './candidate-installer.mjs'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

describe('selectCandidateInstaller', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'candidate-installer-'))
    writeFileSync(join(dir, 'Metis-Setup-1.0.0.exe'), 'setup bytes')
    writeFileSync(join(dir, 'Metis-Portable-1.0.0.exe'), 'portable bytes')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('returns the Setup installer whose sha256 matches, ignoring case and whitespace', async () => {
    expect(await selectCandidateInstaller(dir, ` ${sha('setup bytes').toUpperCase()}\n`)).toBe(
      join(dir, 'Metis-Setup-1.0.0.exe')
    )
  })

  it('refuses bytes that differ from the named sha256, and never falls back to another file', async () => {
    await expect(selectCandidateInstaller(dir, sha('other bytes'))).rejects.toThrow(/No installer matches/)
    await expect(selectCandidateInstaller(dir, sha('portable bytes'))).rejects.toThrow(/No installer matches/)
  })

  it('rejects a malformed sha256 and a directory without a Setup installer', async () => {
    await expect(selectCandidateInstaller(dir, 'v1.9.6')).rejects.toThrow(/64 hexadecimal/)
    rmSync(join(dir, 'Metis-Setup-1.0.0.exe'))
    await expect(selectCandidateInstaller(dir, sha('setup bytes'))).rejects.toThrow(/No Metis-Setup/)
  })
})
