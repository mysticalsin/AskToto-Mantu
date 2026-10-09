import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  allocateWorkspace,
  archiveEntryProblems,
  buildNativeReport,
  bundleGraphProblems,
  cleanupWorkspace,
  closedFailure,
  nativeIdentityProblems,
  parseAdHocSignature,
  parseMeasuredSlices,
  reportProblems,
  verifyOwnedWorkspace
} from './verify-native-mac-package.mjs'

const source = { sha: 'a'.repeat(40), run_id: '123', run_attempt: '1' }
const bundle = { id: 'com.mantu.metis.native', version: '1.9.7', build: '1', executable: 'Metis' }
const graph = () => [
  { path: '', kind: 'directory', nlink: 2, size: 0 },
  { path: 'Contents', kind: 'directory', nlink: 2, size: 0 },
  { path: 'Contents/Info.plist', kind: 'file', nlink: 1, size: 50 },
  { path: 'Contents/MacOS', kind: 'directory', nlink: 2, size: 0 },
  { path: 'Contents/MacOS/Metis', kind: 'file', nlink: 1, size: 100 },
  { path: 'Contents/Frameworks', kind: 'directory', nlink: 2, size: 0 },
  { path: 'Contents/Frameworks/Example.framework', kind: 'directory', nlink: 2, size: 0 },
  { path: 'Contents/Frameworks/Example.framework/Versions', kind: 'directory', nlink: 2, size: 0 },
  { path: 'Contents/Frameworks/Example.framework/Versions/A', kind: 'directory', nlink: 2, size: 0 },
  { path: 'Contents/Frameworks/Example.framework/Versions/A/Example', kind: 'file', nlink: 1, size: 100 }
]
const link = (overrides = {}) => ({
  path: 'Contents/Frameworks/Example.framework/Example',
  kind: 'symlink',
  nlink: 1,
  size: 30,
  target: 'Versions/A/Example',
  resolved: 'Contents/Frameworks/Example.framework/Versions/A/Example',
  ...overrides
})
const validInput = () => ({
  source: { ...source },
  checkoutSha: source.sha,
  expectedVersion: '1.9.7',
  asset: { filename: 'Metis-Native-1.9.7.zip', bytes: 200, sha256: 'b'.repeat(64) },
  bundle: { ...bundle },
  slices: ['arm64'],
  signature: 'AD_HOC'
})

describe('native same-job archive entry policy', () => {
  it('accepts the one app and the optional resource-fork tree without accepting another product', () => {
    expect(
      archiveEntryProblems([
        'Metis.app/',
        'Metis.app/Contents/Info.plist',
        'Metis.app/Contents/MacOS/Metis',
        '__MACOSX/',
        '__MACOSX/Metis.app/',
        '__MACOSX/Metis.app/Contents/._Info.plist'
      ])
    ).toEqual([])
  })

  it.each([
    '',
    '/Metis.app/Contents/file',
    'C:/Metis.app/file',
    'Metis.app\\Contents\\file',
    'Metis.app/../outside',
    'Metis.app/./Contents',
    'Metis.app//Contents',
    'Metis.app/Contents/with\u0000nul',
    'Metis.app/Contents/with\nnewline',
    'Metis.app/Contents/with\rreturn',
    'Other.app/Contents/file',
    '__MACOSX/Other.app/file',
    '__MACOSX/._Metis.app'
  ])('rejects an entry outside the admitted archive shape: %j', (entry) => {
    expect(archiveEntryProblems(['Metis.app/', entry]).length).toBeGreaterThan(0)
  })

  it.each([
    ['Metis.app/Contents', 'Metis.app/Contents/'],
    ['Metis.app/Contents/file', 'Metis.app/Contents/file'],
    ['Metis.app/Contents/FILE', 'Metis.app/Contents/file'],
    ['Metis.app/Contents/Me\u0301tis', 'Metis.app/Contents/Métis']
  ])('rejects duplicate or filesystem-alias entries', (first, second) => {
    expect(archiveEntryProblems([first, second])).toContain('ARCHIVE_ENTRY_ALIAS')
  })

  it('rejects an empty archive and metadata without the app', () => {
    expect(archiveEntryProblems([])).toContain('ARCHIVE_APP_MISSING')
    expect(archiveEntryProblems(['__MACOSX/'])).toContain('ARCHIVE_APP_MISSING')
  })
})

describe('native extracted bundle graph policy', () => {
  it('accepts regular files and framework-contained relative links', () => {
    expect(bundleGraphProblems([...graph(), link()])).toEqual([])
    expect(
      bundleGraphProblems([
        ...graph(),
        link({
          path: 'Contents/Frameworks/Example.framework/Versions/Current',
          target: 'A',
          resolved: 'Contents/Frameworks/Example.framework/Versions/A'
        })
      ])
    ).toEqual([])
  })

  it.each([
    { target: '/outside' },
    { target: 'C:\\outside' },
    { target: '../../../outside' },
    { resolved: '../outside' },
    { resolved: 'Contents/Frameworks/Other.framework/Example' },
    { resolved: null },
    { path: 'Contents/Resources/link' },
    { resolved: 'Contents/Frameworks/Example.framework' }
  ])('rejects absolute, escaped, unresolved, cyclic or non-framework links', (overrides) => {
    expect(bundleGraphProblems([...graph(), link(overrides)]).length).toBeGreaterThan(0)
  })

  it('requires the real framework root and a recorded target, not a similar prefix', () => {
    const withoutRoot = graph().filter((entry) => entry.path !== 'Contents/Frameworks/Example.framework')
    expect(bundleGraphProblems([...withoutRoot, link()]).length).toBeGreaterThan(0)
    expect(
      bundleGraphProblems([...graph(), link({ resolved: 'Contents/Frameworks/Example.framework-elsewhere/file' })])
        .length
    ).toBeGreaterThan(0)
    expect(
      bundleGraphProblems([...graph(), link({ resolved: 'Contents/Frameworks/Example.framework/missing' })]).length
    ).toBeGreaterThan(0)
  })

  it.each(['socket', 'fifo', 'device'])('rejects special entries: %s', (kind) => {
    expect(bundleGraphProblems([...graph(), { path: 'Contents/special', kind, nlink: 1, size: 0 }])).toContain(
      'BUNDLE_ENTRY_KIND_INVALID'
    )
  })

  it('rejects hard-link aliases, duplicate names, symlink roots and non-directory parents', () => {
    expect(bundleGraphProblems([...graph(), { path: 'Contents/alias', kind: 'file', nlink: 2, size: 10 }])).toContain(
      'BUNDLE_HARDLINK_INVALID'
    )
    expect(bundleGraphProblems([...graph(), graph()[2]])).toContain('BUNDLE_ENTRY_ALIAS')
    expect(bundleGraphProblems([{ ...graph()[0], kind: 'symlink' }, ...graph().slice(1)]).length).toBeGreaterThan(0)
    expect(
      bundleGraphProblems([...graph(), { path: 'Contents/Info.plist/child', kind: 'file', nlink: 1, size: 5 }]).length
    ).toBeGreaterThan(0)
  })
})

describe('native identity, measured slices and closed report', () => {
  it('requires exact bundle and executed-source identity', () => {
    expect(nativeIdentityProblems(validInput())).toEqual([])
    for (const change of [
      { bundle: { ...bundle, id: 'com.mantu.asktoto' } },
      { bundle: { ...bundle, version: '2.0.0' } },
      { bundle: { ...bundle, executable: '../Metis' } },
      { bundle: { ...bundle, executable: '' } },
      { bundle: { ...bundle, build: 'private text' } },
      { checkoutSha: 'c'.repeat(40) },
      { source: { ...source, sha: 'not-a-sha' } },
      { source: { ...source, run_id: '0' } },
      { source: { ...source, run_attempt: '0' } }
    ]) {
      expect(nativeIdentityProblems({ ...validInput(), ...change }).length).toBeGreaterThan(0)
    }
  })

  it('measures only supported slices, without requiring or claiming a universal binary', () => {
    expect(parseMeasuredSlices('arm64\n')).toEqual(['arm64'])
    expect(parseMeasuredSlices('x86_64 arm64\n')).toEqual(['arm64', 'x86_64'])
    for (const value of ['', 'i386', 'arm64 arm64', 'arm64 unknown']) {
      expect(() => parseMeasuredSlices(value)).toThrow('SLICES_INVALID')
    }
  })

  it('accepts only an unambiguous ad-hoc signature mode and never exposes native error content', () => {
    expect(parseAdHocSignature('Format=app bundle\nSignature=adhoc\nTeamIdentifier=not set\n')).toBe('AD_HOC')
    for (const text of ['', 'Signature=adhoc\nSignature=adhoc', 'Signature=adhoc\nAuthority=Publisher']) {
      expect(() => parseAdHocSignature(text)).toThrow('SIGNATURE_MODE_INVALID')
    }
    expect(closedFailure(new Error('SIGNATURE_INTEGRITY_FAILED'))).toBe('SIGNATURE_INTEGRITY_FAILED')
    expect(closedFailure(new Error('SIGNATURE_INTEGRITY_FAILED\nprivate tool output'))).toBe(
      'NATIVE_PACKAGE_VERIFICATION_FAILED'
    )
    expect(closedFailure(new Error('private tool output'))).toBe('NATIVE_PACKAGE_VERIFICATION_FAILED')
  })

  it('emits only the closed public-safe keys and leaves architecture/runtime policy unevaluated', () => {
    const report = buildNativeReport(validInput())
    expect(report).toEqual({
      schema: 'metis.native-package-baseline.v1',
      source,
      asset: { filename: 'Metis-Native-1.9.7.zip', bytes: 200, sha256: 'b'.repeat(64) },
      bundle: { id: bundle.id, version: bundle.version, build: bundle.build },
      slices: ['arm64'],
      signature: 'AD_HOC',
      checks: {
        archive_integrity: 'PASS',
        bundle_graph: 'PASS',
        bundle_identity: 'PASS',
        signature_integrity: 'PASS',
        architecture_policy: 'NOT_EVALUATED',
        runtime: 'NOT_EVALUATED'
      }
    })
    expect(reportProblems(report)).toEqual([])
  })

  it('refuses extra keys, unknown verdicts, unsupported slices and forged identity', () => {
    const report = buildNativeReport(validInput())
    for (const changed of [
      { ...report, path: 'private' },
      { ...report, source: { ...report.source, endpoint: 'private' } },
      { ...report, asset: { ...report.asset, bytes: 0 } },
      { ...report, asset: { ...report.asset, filename: 'Metis-Native-2.0.0.zip' } },
      { ...report, asset: { ...report.asset, sha256: '' } },
      { ...report, bundle: { ...report.bundle, executable: 'Metis' } },
      { ...report, signature: 'SIGNED' },
      { ...report, slices: ['arm64', 'arm64'] },
      { ...report, checks: { ...report.checks, runtime: 'PASS' } },
      { ...report, checks: { ...report.checks, raw_output: 'private' } }
    ]) {
      expect(reportProblems(changed).length).toBeGreaterThan(0)
    }
    expect(() => buildNativeReport({ ...validInput(), signature: 'SIGNED' })).toThrow()
    expect(() => buildNativeReport({ ...validInput(), checkoutSha: 'c'.repeat(40) })).toThrow()
  })
})

describe('native helper directory ownership', () => {
  it('allocates separate empty directories and deletes only its receipt-bound workspace', () => {
    const parent = mkdtempSync(join(tmpdir(), 'native-verifier-test-'))
    try {
      const workspace = allocateWorkspace(parent, source)
      const paths = verifyOwnedWorkspace(workspace, parent, source)
      expect(new Set([paths.output, paths.inspection, paths.report]).size).toBe(3)
      for (const path of Object.values(paths)) expect(readdirSync(path)).toEqual([])
      const receipt = readFileSync(join(workspace.root, 'ownership.json'))
      expect(createHash('sha256').update(receipt).digest('hex')).toBe(workspace.ownerDigest)
      cleanupWorkspace(workspace, parent, source)
      expect(existsSync(workspace.root)).toBe(false)
      expect(existsSync(parent)).toBe(true)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('refuses a foreign root, changed receipt or mismatched run without deleting anything', () => {
    const parent = mkdtempSync(join(tmpdir(), 'native-verifier-test-'))
    try {
      const workspace = allocateWorkspace(parent, source)
      const foreign = join(parent, 'foreign')
      mkdirSync(foreign)
      expect(() => cleanupWorkspace({ ...workspace, root: foreign }, parent, source)).toThrow()
      expect(() => cleanupWorkspace(workspace, parent, { ...source, run_id: '456' })).toThrow()
      writeFileSync(join(workspace.root, 'ownership.json'), '{}')
      expect(() => cleanupWorkspace(workspace, parent, source)).toThrow()
      expect(existsSync(workspace.root)).toBe(true)
      expect(existsSync(foreign)).toBe(true)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('refuses a replaced root and a linked child without following either', () => {
    const parent = mkdtempSync(join(tmpdir(), 'native-verifier-test-'))
    try {
      const workspace = allocateWorkspace(parent, source)
      const paths = verifyOwnedWorkspace(workspace, parent, source)
      const foreign = join(parent, 'foreign')
      mkdirSync(foreign)
      const heldOutput = `${paths.output}-held`
      renameSync(paths.output, heldOutput)
      symlinkSync(foreign, paths.output, 'junction')
      expect(() => verifyOwnedWorkspace(workspace, parent, source)).toThrow()
      rmSync(paths.output)
      renameSync(heldOutput, paths.output)
      expect(verifyOwnedWorkspace(workspace, parent, source).output).toBe(paths.output)
      const moved = `${workspace.root}-moved`
      renameSync(workspace.root, moved)
      mkdirSync(workspace.root)
      writeFileSync(join(workspace.root, 'ownership.json'), readFileSync(join(moved, 'ownership.json')))
      expect(() => cleanupWorkspace(workspace, parent, source)).toThrow()
      expect(existsSync(foreign)).toBe(true)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('refuses replacement of an allocated child directory, even when the replacement is empty', () => {
    const parent = mkdtempSync(join(tmpdir(), 'native-verifier-test-'))
    try {
      const workspace = allocateWorkspace(parent, source)
      const paths = verifyOwnedWorkspace(workspace, parent, source)
      renameSync(paths.inspection, `${paths.inspection}-held`)
      mkdirSync(paths.inspection)
      expect(() => verifyOwnedWorkspace(workspace, parent, source)).toThrow()
      expect(existsSync(workspace.root)).toBe(true)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('allows final cleanup after inspection removal, but not after an output or report disappears', () => {
    const parent = mkdtempSync(join(tmpdir(), 'native-verifier-test-'))
    try {
      for (const missing of ['output', 'inspection', 'report'] as const) {
        const workspace = allocateWorkspace(parent, source)
        const paths = verifyOwnedWorkspace(workspace, parent, source)
        rmSync(paths[missing], { recursive: true })
        if (missing === 'inspection') {
          cleanupWorkspace(workspace, parent, source)
          expect(existsSync(workspace.root)).toBe(false)
        } else {
          expect(() => cleanupWorkspace(workspace, parent, source)).toThrow()
          expect(existsSync(workspace.root)).toBe(true)
        }
      }
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })
})
