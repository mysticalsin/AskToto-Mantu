import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PINNED,
  downloadUrl,
  extractZip,
  installArtifactSigningModule,
  installRoot,
  parseManifestRequiredModules,
  parseManifestVersion,
  readZipEntries,
  verifyManifest
} from './artifact-signing-module.mjs'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'metis-artifact-signing-'))
  scratch.push(dir)
  return dir
}

// Minimal stored-only (method 0) ZIP writer for test fixtures. The installer's own extractor also
// reads method 8 (deflate) — exercised for real against the actual PSGallery package below — but
// fixtures never need compression, and whole-nupkg SHA-256 (verified before any entry is read) is the
// integrity gate, not per-entry CRC32, so these fixtures leave crc32 as 0.
function buildZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, nameBuf, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(0, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBuf)

    offset += local.length + nameBuf.length + data.length
  }
  const centralDirectory = Buffer.concat(centralParts)
  const localSection = Buffer.concat(localParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDirectory.length, 12)
  eocd.writeUInt32LE(localSection.length, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([localSection, centralDirectory, eocd])
}

function manifest(version: string, requiredModules: string[] = []) {
  const requiredModulesBlock =
    requiredModules.length > 0 ? `@(${requiredModules.map((m) => `"${m}"`).join(', ')})` : '@()'
  return [
    '@{',
    '    RootModule = "ArtifactSigning.psm1"',
    `    ModuleVersion = '${version}'`,
    `    RequiredModules = ${requiredModulesBlock}`,
    '    FunctionsToExport = @("Invoke-ArtifactSigning")',
    '}'
  ].join('\n')
}

function fixtureZip(pinned = PINNED, requiredModules: string[] = []) {
  return buildZip([
    { name: `${pinned.name}.psd1`, data: Buffer.from(manifest(pinned.version, requiredModules), 'utf8') },
    { name: `${pinned.name}.psm1`, data: Buffer.from('function Invoke-ArtifactSigning {}\n', 'utf8') }
  ])
}

function stubFetch(buffer: Buffer, ok = true, status = 200) {
  return async () => ({ ok, status, arrayBuffer: async () => buffer })
}

describe('artifact-signing-module: manifest parsing', () => {
  it('reads ModuleVersion and RequiredModules out of a PSD1 hashtable', () => {
    expect(parseManifestVersion(manifest('0.1.20'))).toBe('0.1.20')
    expect(parseManifestRequiredModules(manifest('0.1.20'))).toEqual([])
    expect(parseManifestRequiredModules(manifest('0.1.20', ['SomeOtherModule']))).toEqual(['"SomeOtherModule"'])
  })

  it('verifies the manifest version matches the pin exactly and has no RequiredModules', () => {
    expect(verifyManifest(manifest('0.1.20'), PINNED)).toBe('0.1.20')
  })

  it('rejects a manifest reporting a different version than the one that was pinned and requested', () => {
    expect(() => verifyManifest(manifest('0.1.21'), PINNED)).toThrow('ARTIFACT_SIGNING_MANIFEST_VERSION_MISMATCH')
  })

  it('fails closed on any RequiredModules entry instead of silently trusting an unpinned dependency', () => {
    expect(() => verifyManifest(manifest('0.1.20', ['SomeOtherModule']), PINNED)).toThrow(
      'ARTIFACT_SIGNING_REQUIRED_MODULES_UNSUPPORTED'
    )
  })
})

describe('artifact-signing-module: zip extraction', () => {
  it('extracts stored entries into nested directories', () => {
    const root = workspace()
    const dest = join(root, 'out')
    extractZip(fixtureZip(), dest)
    expect(readFileSync(join(dest, 'ArtifactSigning.psd1'), 'utf8')).toContain("ModuleVersion = '0.1.20'")
    expect(readFileSync(join(dest, 'ArtifactSigning.psm1'), 'utf8')).toContain('Invoke-ArtifactSigning')
  })

  it('reads real deflate-compressed PSGallery-style archives, not only the stored test fixtures', async () => {
    // Round-trip through Node's own deflateRaw so this suite proves method 8 (not just method 0),
    // without needing the real network fetch this installer's own tests stub out everywhere else.
    const zlib = await import('node:zlib')
    const data = Buffer.from('function Invoke-ArtifactSigning { "compressed" }\n'.repeat(50), 'utf8')
    const compressed = zlib.deflateRawSync(data)
    const nameBuf = Buffer.from('ArtifactSigning.psm1', 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(8, 8) // method 8 = deflate
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(0, 42)
    const localSection = Buffer.concat([local, nameBuf, compressed])
    const centralDirectory = Buffer.concat([central, nameBuf])
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(1, 8)
    eocd.writeUInt16LE(1, 10)
    eocd.writeUInt32LE(centralDirectory.length, 12)
    eocd.writeUInt32LE(localSection.length, 16)
    const zip = Buffer.concat([localSection, centralDirectory, eocd])

    expect(readZipEntries(zip)).toEqual([
      { name: 'ArtifactSigning.psm1', method: 8, compressedSize: compressed.length, uncompressedSize: data.length, localHeaderOffset: 0 }
    ])
    const root = workspace()
    const dest = join(root, 'out')
    extractZip(zip, dest)
    expect(readFileSync(join(dest, 'ArtifactSigning.psm1'), 'utf8')).toBe(data.toString('utf8'))
  })

  it('rejects a zip-slip entry instead of writing outside the extraction root', () => {
    const root = workspace()
    const dest = join(root, 'out')
    const malicious = buildZip([{ name: '../../evil.txt', data: Buffer.from('nope') }])
    expect(() => extractZip(malicious, dest)).toThrow('ARTIFACT_SIGNING_ZIP_PATH_UNSAFE')
    expect(existsSync(join(root, 'evil.txt'))).toBe(false)
    expect(existsSync(dest)).toBe(false)
  })

  it('rejects an absolute-path entry the same way', () => {
    const root = workspace()
    const dest = join(root, 'out')
    const malicious = buildZip([{ name: '/etc/evil.txt', data: Buffer.from('nope') }])
    expect(() => extractZip(malicious, dest)).toThrow('ARTIFACT_SIGNING_ZIP_PATH_UNSAFE')
  })
})

describe('artifact-signing-module: install', () => {
  it('pins an exact version and a 64-character lowercase-hex SHA-256, and builds the documented download URL', () => {
    expect(PINNED.name).toBe('ArtifactSigning')
    expect(PINNED.version).toBe('0.1.20')
    expect(PINNED.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(downloadUrl(PINNED)).toBe('https://www.powershellgallery.com/api/v2/package/ArtifactSigning/0.1.20')
  })

  it('confines the install root under RUNNER_TEMP when set, and falls back to the OS temp dir otherwise', () => {
    expect(installRoot({ RUNNER_TEMP: '/runner/temp' })).toBe(join('/runner/temp', 'artifact-signing', PINNED.version))
    expect(installRoot({})).toBe(join(tmpdir(), 'artifact-signing', PINNED.version))
  })

  it('rejects a downloaded archive whose SHA-256 does not match the pin, and installs nothing', async () => {
    const root = workspace()
    const wrongBytes = Buffer.from('not the pinned package')
    await expect(
      installArtifactSigningModule({ env: { RUNNER_TEMP: root }, fetchFn: stubFetch(wrongBytes) })
    ).rejects.toThrow('ARTIFACT_SIGNING_SHA256_MISMATCH')
    expect(existsSync(installRoot({ RUNNER_TEMP: root }))).toBe(false)
  })

  it('rejects a non-OK download response', async () => {
    const root = workspace()
    await expect(
      installArtifactSigningModule({ env: { RUNNER_TEMP: root }, fetchFn: stubFetch(Buffer.from(''), false, 404) })
    ).rejects.toThrow('ARTIFACT_SIGNING_DOWNLOAD_FAILED:404')
  })

  it('rejects an archive whose extracted manifest reports a version other than the one requested', async () => {
    const root = workspace()
    const wrongVersionPinned = { ...PINNED, sha256: '' }
    const zip = fixtureZip({ ...PINNED, version: '9.9.9' })
    wrongVersionPinned.sha256 = createHash('sha256').update(zip).digest('hex')
    await expect(
      installArtifactSigningModule({ env: { RUNNER_TEMP: root }, fetchFn: stubFetch(zip), pinned: wrongVersionPinned })
    ).rejects.toThrow('ARTIFACT_SIGNING_MANIFEST_VERSION_MISMATCH')
  })

  it('installs a verified archive under the confined root, and records ARTIFACT_SIGNING_MODULE_PATH for later steps', async () => {
    const root = workspace()
    const zip = fixtureZip()
    const pinned = { ...PINNED, sha256: createHash('sha256').update(zip).digest('hex') }
    const githubEnvFile = join(root, 'github-env')
    const path = await installArtifactSigningModule({
      env: { RUNNER_TEMP: root, GITHUB_ENV: githubEnvFile },
      fetchFn: stubFetch(zip),
      pinned
    })
    expect(path).toBe(join(root, 'artifact-signing', pinned.version, 'ArtifactSigning.psd1'))
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(githubEnvFile, 'utf8')).toBe(`ARTIFACT_SIGNING_MODULE_PATH=${path}\n`)
  })

  it('clears a stale prior extraction rather than merging an old and a new version together', async () => {
    const root = workspace()
    const zip = fixtureZip()
    const pinned = { ...PINNED, sha256: createHash('sha256').update(zip).digest('hex') }
    const target = installRoot({ RUNNER_TEMP: root }, pinned)
    const stalePath = join(target, 'stale-leftover-file.txt')
    mkdirSync(target, { recursive: true })
    writeFileSync(stalePath, 'from a previous, differently-pinned install')
    await installArtifactSigningModule({ env: { RUNNER_TEMP: root }, fetchFn: stubFetch(zip), pinned })
    expect(existsSync(stalePath)).toBe(false)
  })
})
