import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  asarPhysicalAccounting,
  assertOwnedDisjoint,
  copyProjection,
  digestPaths,
  managedNodeChildren,
  partitionManifest,
  portableTreeManifestSha256,
  validateMatrixBinding,
  validateProbeRecord,
  validateReportArtifactRoster,
  walkTree
} from './lean-payload-attribution.mjs'
import {
  archiveMembers,
  archiveCompression,
  asarGroup,
  assertArchiveMembersMatch,
  deriveNsisCustomFiles,
  parse7zListing
} from './lean-payload-compression.mjs'
import { asarMemberInventory } from './lean-payload-inventory.mjs'
import { readNsisCompletionEvent } from '../diagnostics/capture-lean-nsis-payload.mjs'

const roots: string[] = []

async function temporaryRoot() {
  const path = await mkdtemp(join(tmpdir(), 'lean-attribution-contract-'))
  roots.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('lean payload attribution contracts', () => {
  it('assigns every physical app path to exactly one top-level component', async () => {
    const root = await temporaryRoot()
    await mkdir(join(root, 'resources', 'app.asar.unpacked'), { recursive: true })
    await writeFile(join(root, 'resources', 'app.asar'), 'packed')
    await writeFile(join(root, 'resources', 'app.asar.unpacked', 'media.mp4'), 'unpacked')
    await writeFile(join(root, 'Metis'), 'shell')
    const manifest = await walkTree(root)
    const parts = partitionManifest(manifest, 'win32')
    const assigned = Object.values(parts).flat()
    expect(assigned).toHaveLength(manifest.entries.length)
    expect(new Set(assigned).size).toBe(manifest.entries.length)
    expect(parts['app-asar']).toContain('resources/app.asar')
    expect(parts['app-asar-unpacked']).toContain('resources/app.asar.unpacked/media.mp4')
  })

  it('rejects duplicate normalized paths instead of double-counting them', () => {
    const entry = {
      path: 'resources/app.asar',
      type: 'file',
      mode: 0o644,
      bytes: 1,
      sha256: 'a'.repeat(64),
      lstatBytes: 1
    }
    expect(() => partitionManifest({ entries: [entry, entry] } as never, 'win32')).toThrow(/more than once/)
  })

  it('keeps physical ASAR and unpacked accounting separate from logical member bytes', () => {
    const accounting = asarPhysicalAccounting(
      { bytes: 111, sha256: 'b'.repeat(64) },
      [
        { path: 'out/main.js', type: 'file', bytes: 40, sha256: 'c'.repeat(64), packed: true, unpacked: false },
        {
          path: 'out/renderer/video.mp4',
          type: 'file',
          bytes: 60,
          sha256: 'd'.repeat(64),
          packed: false,
          unpacked: true
        }
      ],
      { totals: { lstatBytes: 60, regularFileBytes: 60, linkTextBytes: 0 } }
    )
    expect(accounting).toMatchObject({
      appAsarPhysicalBytes: 111,
      packedMemberRawBytes: 40,
      appAsarUnpackedPhysicalBytes: 60,
      unpackedMemberRawBytesSecondary: 60
    })
    expect(accounting.note).toContain('not added to physical totals')
  })

  it('discovers actual managed Node child groups from packaged paths', () => {
    const entries = [
      'Contents/Resources/managed-node/darwin-arm64/bin/node',
      'Contents/Resources/managed-node/darwin-arm64/include/node/node.h',
      'Contents/Resources/managed-node/darwin-arm64/lib/node_modules/npm/package.json',
      'Contents/Resources/managed-node/darwin-arm64/lib/node_modules/npm/README.md',
      'Contents/Resources/managed-node/darwin-arm64/lib/node_modules/npm/man/npm.1',
      'Contents/Resources/managed-node/darwin-arm64/lib/node_modules/npm/LICENSE',
      'Contents/Resources/managed-node/darwin-arm64/share/doc/node/README.md',
      'Contents/Resources/managed-node/darwin-arm64/share/licenses/LICENSE',
      'Contents/Resources/managed-node/darwin-arm64/lib/node_modules/corepack/package.json'
    ].map((path) => ({ path, type: 'file' as const, mode: 0o644, bytes: 1, sha256: 'e'.repeat(64), lstatBytes: 1 }))
    const children = managedNodeChildren({ entries } as never, 'darwin')
    expect(children.executable).toEqual([entries[0].path])
    expect(children.headers).toEqual([entries[1].path])
    expect(children.npm).toEqual([entries[2].path])
    expect(children.docs).toEqual([entries[3].path, entries[4].path, entries[6].path])
    expect(children.licenses).toEqual([entries[5].path, entries[7].path])
    expect(children.tooling).toEqual([entries[8].path])
  })

  it('does not bind portable DMG identity to filesystem-dependent directory allocation', () => {
    const entries = [
      { path: 'Contents', type: 'directory', mode: 0o755, lstatBytes: 12 },
      { path: 'Contents/Resources', type: 'directory', mode: 0o755, lstatBytes: 32 },
      { path: 'Contents/Resources/app.bin', type: 'file', mode: 0o644, bytes: 4, sha256: 'a'.repeat(64), lstatBytes: 4 }
    ]
    const mounted = entries.map((entry) =>
      entry.type === 'directory' ? { ...entry, mode: 0o700, lstatBytes: entry.lstatBytes + 512 } : entry
    )
    expect(portableTreeManifestSha256(entries)).toBe(portableTreeManifestSha256(mounted))
    expect(portableTreeManifestSha256(entries)).toBe(portableTreeManifestSha256([...entries].reverse()))
  })

  it('inventories actual locked ASAR directories, packed/unpacked files, and links', async () => {
    const root = await temporaryRoot()
    const source = join(root, 'source')
    const archive = join(root, 'fixture.asar')
    await mkdir(join(source, 'nested'), { recursive: true })
    await writeFile(join(source, 'packed.txt'), 'packed bytes')
    await writeFile(join(source, 'native.node'), 'native bytes')
    await mkdir(join(source, 'out', 'main'), { recursive: true })
    await mkdir(join(source, 'out', 'renderer'), { recursive: true })
    await mkdir(join(source, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(source, 'out', 'main', 'entry.js'), 'main bundle')
    await writeFile(join(source, 'out', 'renderer', 'entry.js'), 'renderer bundle')
    await writeFile(join(source, 'node_modules', 'pkg', 'index.js'), 'production package')
    await writeFile(join(source, 'nested', 'target.txt'), 'link target')
    await symlink('target.txt', join(source, 'nested', 'alias'))
    await symlink('../native.node', join(source, 'nested', 'native-link.node'))
    const asar = createRequire(import.meta.url)('@electron/asar')
    await asar.createPackageWithOptions(source, archive, { unpack: '**/*.node' })
    const result = await asarMemberInventory(process.cwd(), archive, `${archive}.unpacked`)
    expect(result.members.find((member) => member.path === 'nested')?.type).toBe('directory')
    expect(result.members.find((member) => member.path === 'nested/alias')?.type).toBe('symlink')
    expect(result.members.find((member) => member.path === 'nested/native-link.node')).toMatchObject({
      type: 'symlink',
      unpacked: true,
      physicalLinkText: '../native.node'
    })
    expect(result.members.find((member) => member.path === 'packed.txt')).toMatchObject({ packed: true, type: 'file' })
    expect(result.members.find((member) => member.path === 'native.node')).toMatchObject({
      unpacked: true,
      type: 'file'
    })
    expect(result.members.find((member) => member.path === 'out/main/entry.js')?.group).toBe('out/main')
    expect(result.members.find((member) => member.path === 'out/renderer/entry.js')?.group).toBe('renderer')
    expect(result.members.find((member) => member.path === 'node_modules/pkg/index.js')?.group).toBe(
      'production-packages'
    )
    expect(result.physicalAccounting.appAsarUnpackedPhysicalBytes).toBeGreaterThan(0)
  })

  it('parses the 7z listing header and blank-line-separated member records', () => {
    const listing = parse7zListing(
      `7-Zip 24.09\nPath = fixture.7z\nType = 7z\nMethod = LZMA2:24\nSolid = +\nBlocks = 3\n----------\nPath = docs\nFolder = +\n\nPath = docs/first.bin\nFolder = -\nSize = 10\nPacked Size = 4\nMethod = LZMA2:24\nBlock = 2\n\nPath = docs/second.bin\nFolder = -\nSize = 27\nPacked Size = 8\nMethod = LZMA:20\nBlock = 1\n`
    )
    expect(archiveMembers(listing)).toEqual([
      { path: 'docs', bytes: 0, type: 'directory' },
      { path: 'docs/first.bin', bytes: 10, type: 'file' },
      { path: 'docs/second.bin', bytes: 27, type: 'file' }
    ])
    expect(archiveCompression(listing)).toEqual({
      method: 'LZMA2:24',
      dictionary: '24',
      solid: true,
      blocks: 3,
      memberMethod: 'LZMA2:24',
      memberBlock: 2,
      memberCompression: [
        { path: 'docs/first.bin', method: 'LZMA2:24', block: 2 },
        { path: 'docs/second.bin', method: 'LZMA:20', block: 1 }
      ]
    })
    expect(asarGroup('out/main/entry.js')).toBe('out/main')
  })

  it('rejects an escaping symlink and inventories a safe link without traversing it', async () => {
    const root = await temporaryRoot()
    await mkdir(join(root, 'tree'))
    await writeFile(join(root, 'outside.txt'), 'outside')
    await writeFile(join(root, 'tree', 'inside.txt'), 'inside')
    await symlink('inside.txt', join(root, 'tree', 'safe-link'))
    const safe = await walkTree(join(root, 'tree'))
    expect(safe.entries.some((entry) => entry.path === 'inside.txt')).toBe(true)
    expect(safe.entries.some((entry) => entry.path === 'safe-link' && entry.type === 'symlink')).toBe(true)
    await symlink('../outside.txt', join(root, 'tree', 'escape-link'))
    await expect(walkTree(join(root, 'tree'))).rejects.toThrow(/escapes app root/)
  })

  it('preserves only manifest-selected paths in a disjoint projection', async () => {
    const root = await temporaryRoot()
    const source = join(root, 'source')
    const destination = join(root, 'scratch', 'projection')
    await mkdir(join(source, 'resources', 'child'), { recursive: true })
    await writeFile(join(source, 'resources', 'child', 'keep.bin'), 'keep')
    await writeFile(join(source, 'resources', 'child', 'omit.bin'), 'omit')
    await mkdir(join(root, 'scratch'))
    const manifest = await walkTree(source)
    const projection = await copyProjection(source, destination, ['resources/child/keep.bin'], manifest.manifestSha256)
    expect(projection.entries.map((entry) => entry.path)).toEqual([
      'resources',
      'resources/child',
      'resources/child/keep.bin'
    ])
    await expect(readFile(join(destination, 'resources', 'child', 'omit.bin'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('rejects a stale manifest before creating a projection', async () => {
    const root = await temporaryRoot()
    const source = join(root, 'source')
    const destination = join(root, 'scratch', 'projection')
    await mkdir(source)
    await writeFile(join(source, 'input.bin'), 'before')
    const manifest = await walkTree(source)
    await writeFile(join(source, 'input.bin'), 'changed')
    await expect(copyProjection(source, destination, ['input.bin'], manifest.manifestSha256)).rejects.toThrow(/stale/)
  })

  it('rejects output aliases with payload inputs and filesystem roots', () => {
    const root = '/workspace/payload'
    expect(() => assertOwnedDisjoint(root, root)).toThrow(/overlap/)
    expect(() => assertOwnedDisjoint('/')).toThrow(/filesystem root/)
    expect(() => assertOwnedDisjoint('/tmp/../payload')).toThrow(/traverse/)
  })

  it('binds closed matrix targets and rejects mismatched source/target identities', () => {
    expect(validateMatrixBinding('mac', 'arm64', 'mac-arm64-udbz')).toMatchObject({
      platform: 'darwin',
      runner: 'macos-latest'
    })
    expect(() => validateMatrixBinding('mac', 'x64', 'mac-arm64-udbz')).toThrow(/closed attribution matrix/)
    expect(() => validateMatrixBinding('win', 'x64', 'mac-x64-udbz')).toThrow(/closed attribution matrix/)
  })

  it('cannot mark partial or unhashed compressor output complete', () => {
    expect(() =>
      validateProbeRecord({
        inputManifestSha256: 'a'.repeat(64),
        selectedPathListSha256: 'b'.repeat(64),
        excludedPathListSha256: 'c'.repeat(64),
        rawMemberBytes: 1,
        status: 'complete',
        outputBytes: 10,
        verified: false
      })
    ).toThrow(/complete without verified output/)
    expect(() =>
      validateProbeRecord({
        inputManifestSha256: 'a'.repeat(64),
        selectedPathListSha256: 'b'.repeat(64),
        excludedPathListSha256: 'c'.repeat(64),
        rawMemberBytes: 1,
        status: 'failed',
        outputBytes: 10,
        outputSha256: 'd'.repeat(64),
        verified: true
      })
    ).toThrow(/Failed probe cannot be verified/)
  })

  it('rejects equal-total 7z probes with an omitted and substituted archive member', () => {
    const expected = [
      { path: 'resources/a.bin', type: 'file', bytes: 40 },
      { path: 'resources/b.bin', type: 'file', bytes: 60 }
    ]
    const actual = [
      { path: 'resources/a.bin', type: 'file', bytes: 40 },
      { path: 'resources/c.bin', type: 'file', bytes: 60 }
    ]
    expect(actual.reduce((sum, entry) => sum + entry.bytes, 0)).toBe(
      expected.reduce((sum, entry) => sum + entry.bytes, 0)
    )
    expect(() => assertArchiveMembersMatch(expected, actual, 'fixture')).toThrow(/member identity mismatch/)
  })

  it('derives direct NSIS custom files from the resolved extension list and Resources traversal', () => {
    const entries = [
      { path: 'resources', type: 'directory' },
      { path: 'resources/media/onboarding.mp4', type: 'file', bytes: 10, sha256: 'a'.repeat(64) },
      { path: 'resources/media/disk.vmdk', type: 'file', bytes: 20, sha256: 'b'.repeat(64) },
      { path: 'resources/node_modules/pkg/demo.mp4', type: 'file', bytes: 30, sha256: 'c'.repeat(64) },
      { path: 'app.asar.unpacked/media.mp4', type: 'file', bytes: 40, sha256: 'd'.repeat(64) }
    ]
    const result = deriveNsisCustomFiles(entries as never, ['.mp4', '.vmdk'])
    expect(result.files.map((entry) => entry.path)).toEqual([
      'resources/media/disk.vmdk',
      'resources/media/onboarding.mp4'
    ])
  })

  it('reads the pinned NSIS artifact completion event file field and resolved options', () => {
    const event = {
      file: 'release/lean-attribution-win-x64-solid/Metis-Setup-1.9.7.exe',
      target: { name: 'nsis', options: { preCompressedFileExtensions: ['.mp4', '.vmdk'] } },
      packager: {},
      arch: 1
    }
    expect(readNsisCompletionEvent(event)).toEqual({
      file: event.file,
      targetName: 'nsis',
      arch: 'x64',
      preCompressedFileExtensions: ['.mp4', '.vmdk']
    })
    expect(() => readNsisCompletionEvent({ ...event, file: undefined, artifact: event.file })).toThrow(/missing file/)
  })

  it('accepts only report data members in the artifact roster', () => {
    expect(
      validateReportArtifactRoster([
        'report.json',
        'app-manifest.json',
        'package-notices.json',
        'probe-full-control-before.json',
        'source-inputs.sha256'
      ])
    ).toHaveLength(5)
    expect(() => validateReportArtifactRoster(['report.json', 'Metis-Setup-1.9.7.exe'])).toThrow(/Non-report artifact/)
    expect(() => validateReportArtifactRoster(['report.json', 'report.json'])).toThrow(/duplicate/)
    expect(() => digestPaths(['resources/app.asar', '../installer.exe'])).toThrow(/Invalid normalized relative path/)
  })

  it('keeps the hosted artifact action closed over report-directory data only', async () => {
    const workflow = await readFile(
      new URL('../../.github/workflows/lean-payload-attribution.yml', import.meta.url),
      'utf8'
    )
    const upload = workflow.slice(workflow.indexOf('name: Upload reports only'))
    const pathBlock =
      upload
        .split('path: |')[1]
        ?.split('\n')
        .slice(1)
        .filter((line) => /^\s{12,}\S/.test(line)) ?? []
    expect(pathBlock.length).toBeGreaterThan(0)
    const prefix = '${{ env.ATTRIBUTION_REPORT_ROOT }}/'
    expect(pathBlock.every((line) => line.trim().startsWith(prefix))).toBe(true)
    const memberNames = pathBlock.map((line) => line.trim().slice(prefix.length))
    expect(memberNames).toEqual([
      'report.json',
      'run-paths.json',
      'capture-hook-identity.json',
      'windows-archive-capture.json',
      'app-manifest.json',
      'asar-members.json',
      'package-notices.json',
      'native-smoke.json',
      'strict-size-measurement.json',
      'probe-*.json',
      'source-inputs.sha256'
    ])
    expect(validateReportArtifactRoster(memberNames)).toHaveLength(memberNames.length)
    expect(/payload-source\/release|\.exe|\.dmg|\.nsis\.7z|\.app\/|node_modules|RUNNER_TEMP/i.test(upload)).toBe(false)
  })
})
