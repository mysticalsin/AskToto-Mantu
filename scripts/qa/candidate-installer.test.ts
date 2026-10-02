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

describe('selectCandidateInstaller on macOS', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'candidate-installer-mac-'))
    writeFileSync(join(dir, 'Metis-1.0.0.dmg'), 'dmg bytes')
    writeFileSync(join(dir, 'Metis-1.0.0.zip'), 'zip bytes')
    writeFileSync(join(dir, 'Metis-Setup-1.0.0.exe'), 'setup bytes')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('returns the DMG or the zip whose sha256 matches', async () => {
    expect(await selectCandidateInstaller(dir, sha('dmg bytes'), 'mac')).toBe(join(dir, 'Metis-1.0.0.dmg'))
    expect(await selectCandidateInstaller(dir, sha('zip bytes'), 'mac')).toBe(join(dir, 'Metis-1.0.0.zip'))
    expect(await selectCandidateInstaller(dir, sha('dmg bytes'), 'mac-dmg')).toBe(join(dir, 'Metis-1.0.0.dmg'))
    await expect(selectCandidateInstaller(dir, sha('zip bytes'), 'mac-dmg')).rejects.toThrow(/No installer matches/)
  })

  it('never selects a Windows installer, and never falls back when nothing matches', async () => {
    await expect(selectCandidateInstaller(dir, sha('setup bytes'), 'mac')).rejects.toThrow(/No installer matches/)
    await expect(selectCandidateInstaller(dir, sha('other bytes'), 'mac')).rejects.toThrow(/No installer matches/)
  })

  it('refuses a directory with no DMG or zip, and an unknown platform', async () => {
    rmSync(join(dir, 'Metis-1.0.0.dmg'))
    rmSync(join(dir, 'Metis-1.0.0.zip'))
    await expect(selectCandidateInstaller(dir, sha('zip bytes'), 'mac')).rejects.toThrow(/No \*\.dmg or \*\.zip/)
    await expect(selectCandidateInstaller(dir, sha('zip bytes'), 'linux')).rejects.toThrow(/Unknown installer platform/)
  })
})
