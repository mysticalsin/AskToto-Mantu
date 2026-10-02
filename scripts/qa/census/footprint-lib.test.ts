import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildFootprintReport,
  classifyFile,
  directoryBytes,
  findDuplicates,
  parseMacGpus,
  parseTtfcBenchOutput,
  parseWindowsGpus,
  runWithTempPeak,
  shippedLocales,
  unmeasuredRows
} from './footprint-lib.mjs'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'metis-footprint-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function write(rel: string, bytes: number, fill: string) {
  const path = join(root, rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, Buffer.alloc(bytes, fill))
}

describe('footprint sizes and duplicates', () => {
  it('sums regular files, ignores symlinks and honours excludes', () => {
    write('app/a.bin', 100, 'a')
    write('app/sub/b.bin', 50, 'b')
    write('other/c.bin', 10, 'c')
    symlinkSync(join(root, 'app/a.bin'), join(root, 'app/link.bin'))
    expect(directoryBytes(join(root, 'app'))).toEqual({ bytes: 150, fileCount: 2 })
    expect(directoryBytes(root, { exclude: [join(root, 'app')] })).toEqual({ bytes: 10, fileCount: 1 })
  })

  it('groups byte-identical large files and counts every copy after the first as waste', () => {
    const mib = 1024 * 1024
    write('a/model.gguf', mib, 'x')
    write('b/model.gguf', mib, 'x')
    write('c/libfoo.dylib', mib, 'y')
    write('d/libfoo.dylib', mib, 'z')
    write('e/tiny.bin', 10, 'x')
    write('f/tiny.bin', 10, 'x')
    const result = findDuplicates(root)
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0]).toMatchObject({
      size: mib,
      kind: 'weights',
      copies: 2,
      wastedBytes: mib,
      paths: ['a/model.gguf', 'b/model.gguf']
    })
    expect(result.wastedBytes).toBe(mib)
    expect(result.wastedByKind).toEqual({ runtime: 0, weights: mib, other: 0 })
  })

  it('classifies weights and runtimes by name', () => {
    expect(classifyFile('x/y.onnx')).toBe('weights')
    expect(classifyFile('x/y.dll')).toBe('runtime')
    expect(classifyFile('x/readme.txt')).toBe('other')
  })
})

describe('footprint inventory parsing', () => {
  it('lists shipped locales per platform', () => {
    mkdirSync(join(root, 'Metis.app/Contents/Resources/fr.lproj'), { recursive: true })
    mkdirSync(join(root, 'Metis.app/Contents/Resources/en.lproj'), { recursive: true })
    expect(shippedLocales(join(root, 'Metis.app'), 'darwin')).toEqual(['en', 'fr'])
    write('win/locales/de.pak', 1, 'a')
    write('win/other/ja.pak', 1, 'a')
    expect(shippedLocales(join(root, 'win'), 'win32')).toEqual(['de'])
  })

  it('parses GPU listings from both OS queries', () => {
    expect(parseMacGpus({ SPDisplaysDataType: [{ sppci_model: 'Apple M1', sppci_cores: '7' }] })).toEqual([
      { name: 'Apple M1', cores: '7' }
    ])
    expect(parseWindowsGpus('{"Name":"Basic Display","DriverVersion":"1.0"}')).toEqual([
      { name: 'Basic Display', driverVersion: '1.0' }
    ])
  })

  it('parses the TTFC bench and rejects a failed or foreign artifact', () => {
    const ok = '  stub decode:   400 ms\n  TTFC budget:   1600 ms\nPASS: ok\n'
    expect(parseTtfcBenchOutput(ok)).toEqual({ schedulingBudgetMs: 1600, stubDecodeMs: 400 })
    expect(() => parseTtfcBenchOutput('  TTFC budget:   4000 ms\nFAIL: stuck\n')).toThrow(/passing/)
    expect(() => parseTtfcBenchOutput('nothing')).toThrow(/passing/)
  })
})

describe('footprint report', () => {
  it('names the unmeasured rows and never claims live capture latency it did not measure', () => {
    const names = unmeasuredRows({ hasLiveCaptureLatency: false }).map((r) => r.row)
    expect(names).toContain('live-capture-to-caption-latency')
    expect(names).toContain('managed-laptop-footprint')
    expect(unmeasuredRows({ hasLiveCaptureLatency: true }).map((r) => r.row)).not.toContain(
      'live-capture-to-caption-latency'
    )
    const report = buildFootprintReport({
      releaseTag: 'v1.9.6',
      runId: '42',
      artifact: { name: 'Metis.dmg', bytes: 10, sha256: 'ab' },
      unpacked: { bytes: 30, fileCount: 3 },
      temporary: { peakBytes: 5, scope: 'temp' },
      duplicates: { minBytes: 1, groups: [], wastedBytes: 0, wastedByKind: { runtime: 0, weights: 0, other: 0 } },
      latency: { schedulingBudgetMs: 1600, stubDecodeMs: 400, source: 's', liveCaptureToCaptionMs: null },
      inventory: { platform: 'darwin', arch: 'arm64' } as never
    })
    expect(report.sizes).toMatchObject({ compressedBytes: 10, unpackedBytes: 30, temporaryBytes: 5 })
    expect(report.runId).toBe('42')
    expect(report.unmeasured.length).toBeGreaterThan(0)
  })

  it('reports temporary install bytes as unmeasured instead of publishing a number without a peak', () => {
    expect(unmeasuredRows({ hasLiveCaptureLatency: true, hasTemporaryInstallBytes: false })).toContainEqual(
      expect.objectContaining({ row: 'temporary-install-bytes' })
    )
    const report = buildFootprintReport({
      releaseTag: 'v1.9.6',
      runId: null,
      artifact: { name: 'Metis.dmg', bytes: 10, sha256: 'ab' },
      unpacked: { bytes: 30, fileCount: 3 },
      temporary: null,
      duplicates: { minBytes: 1, groups: [], wastedBytes: 0, wastedByKind: { runtime: 0, weights: 0, other: 0 } },
      latency: { schedulingBudgetMs: null, stubDecodeMs: null, source: null, liveCaptureToCaptionMs: null },
      inventory: { platform: 'darwin', arch: 'arm64' } as never
    })
    expect(report.sizes.temporaryBytes).toBeNull()
    expect(report.unmeasured.map((r: { row: string }) => r.row)).toContain('temporary-install-bytes')
  })
})

describe('runWithTempPeak', () => {
  it('captures files a command writes into the dedicated temp dir and later deletes', async () => {
    const script =
      "const fs=require('fs'),p=require('path');const f=p.join(process.env.TEMP,'unpacked.bin');" +
      "fs.writeFileSync(f,Buffer.alloc(4096));setTimeout(()=>fs.rmSync(f),400)"
    const result = await runWithTempPeak({
      command: process.execPath,
      args: ['-e', script],
      tempDir: join(root, 'scratch'),
      intervalMs: 20
    })
    expect(result.exitCode).toBe(0)
    expect(result.peakBytes).toBe(4096)
    expect(directoryBytes(join(root, 'scratch')).bytes).toBe(0)
  })
})
