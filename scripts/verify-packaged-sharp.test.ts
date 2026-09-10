/** Actual runtime gate + real ASAR + synthetic native headers; never loads Sharp or Electron. */
import { createPackageWithOptions, getRawHeader } from '@electron/asar'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { finished } from 'node:stream/promises'
import type { Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'

const repo = resolve(__dirname, '..')
const roots: string[] = []
const addon = '@img/sharp-win32-x64'
const winNode = `${addon}/lib/sharp-win32-x64-0.35.4.node`
const winDll = `${addon}/lib/libvips-42.dll`
const macAddon = (arch: string) => `@img/sharp-darwin-${arch}`
const macVips = (arch: string) => `@img/sharp-libvips-darwin-${arch}`
const macNode = (arch: string) => `${macAddon(arch)}/lib/sharp-darwin-${arch}-0.35.4.node`
const macDylib = (arch: string) => `${macVips(arch)}/lib/libvips-cpp.8.18.6.dylib`

function put(path: string, content: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}
function json(path: string, value: unknown) { put(path, JSON.stringify(value)) }
function editJson(path: string, change: (value: any) => void) {
  const value = JSON.parse(readFileSync(path, 'utf8'))
  change(value)
  json(path, value)
}
function pe(machine = 0x8664) {
  const bytes = Buffer.alloc(96, 0)
  bytes.write('MZ'); bytes.writeUInt32LE(64, 60)
  bytes.writeUInt32LE(0x00004550, 64); bytes.writeUInt16LE(machine, 68)
  return bytes
}
function macho(arch: string) {
  const bytes = Buffer.alloc(64, 0)
  bytes.writeUInt32LE(0xfeedfacf, 0)
  bytes.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4)
  return bytes
}
interface Fixture {
  root: string
  stage: string
  resources: string
  target: 'win' | 'mac'
  arches: string[]
  source: (relative: string) => string
  staged: (relative: string) => string
  backing: (relative: string) => string
  pack: (unpack?: boolean) => Promise<void>
  run: (postSign?: boolean) => string
}
function fixture(target: 'win' | 'mac' = 'win', arches = ['arm64']): Fixture {
  // Under node_modules only to resolve the actual @electron/asar from the copied, unmodified gate.
  const root = mkdtempSync(join(repo, 'node_modules', '.sharp-gate-'))
  roots.push(root)
  const stage = join(root, 'stage')
  const resources = join(root, 'resources')
  const source = (relative: string) => join(root, 'node_modules', relative)
  const staged = (relative: string) => join(stage, 'node_modules', relative)
  const backing = (relative: string) => join(resources, 'app.asar.unpacked', 'node_modules', relative)
  mkdirSync(join(root, 'scripts'), { recursive: true })
  for (const name of ['check-packaged-runtime.mjs', 'verify-packaged-sharp.mjs']) {
    if (existsSync(join(repo, 'scripts', name))) copyFileSync(join(repo, 'scripts', name), join(root, 'scripts', name))
  }
  put(join(root, 'scripts/local-model-assets.mjs'),
    `export const REPO_ROOT = ${JSON.stringify(root)}; export const LOCAL_MODEL_ASSETS = []; export const LOCAL_MODEL_LICENSE = {};`)
  const lock: Record<string, unknown> = {}
  function pkg(name: string, version: string, manifest: object, files: Record<string, string | Buffer>) {
    lock[`node_modules/${name}`] = { version }
    const contents = { 'package.json': JSON.stringify({ name, version, ...manifest }), ...files }
    for (const [file, content] of Object.entries(contents)) {
      put(source(`${name}/${file}`), content)
      // The pinned builder drops these specific Sharp source-only files and projects package.json.
      if (basename(file).toLowerCase() === 'readme.md' || file.endsWith('.cc') || file.endsWith('.d.ts') || basename(file) === 'binding.gyp') continue
      if (file === 'package.json') {
        const projected = JSON.parse(String(content))
        delete projected.scripts; delete projected.keywords; delete projected.bugs
        json(staged(`${name}/${file}`), projected)
      } else put(staged(`${name}/${file}`), content)
    }
  }
  const optionalDependencies: Record<string, string> = { [addon]: '0.35.4' }
  for (const arch of ['arm64', 'x64']) {
    optionalDependencies[macAddon(arch)] = '0.35.4'
    optionalDependencies[macVips(arch)] = '1.3.3'
  }
  pkg('sharp', '0.35.4', {
    main: './dist/index.cjs', module: './dist/index.mjs', optionalDependencies,
    exports: { '.': { require: { default: './dist/index.cjs' }, import: { default: './dist/index.mjs' } } },
    scripts: { test: 'unused' }, keywords: ['fixture'], bugs: 'unused'
  }, {
    LICENSE: 'synthetic license', 'README.md': 'synthetic readme',
    'dist/index.cjs': 'module.exports = {};', 'dist/index.mjs': 'export default {};',
    'lib/index.d.ts': 'export {};', 'src/common.cc': '// source only',
    'src/common.h': '// shipped header', 'src/binding.gyp': '{}'
  })
  if (target === 'win') {
    pkg(addon, '0.35.4', { exports: { './sharp.node': './index.cjs', './package': './package.json' }, os: ['win32'], cpu: ['x64'] }, {
      LICENSE: 'synthetic license', 'README.md': 'readme',
      'index.cjs': "module.exports = require('./lib/sharp-win32-x64-0.35.4.node');\n",
      'versions.json': JSON.stringify({ heif: '1.23.2', vips: '8.18.6' }),
      'lib/sharp-win32-x64-0.35.4.node': pe(), 'lib/libvips-42.dll': pe(), 'lib/libvips-cpp-8.18.6.dll': pe()
    })
  } else for (const arch of arches) {
    pkg(macAddon(arch), '0.35.4', {
      exports: { './sharp.node': './index.cjs', './package': './package.json' },
      os: ['darwin'], cpu: [arch], optionalDependencies: { [macVips(arch)]: '1.3.3' }
    }, {
      LICENSE: 'synthetic license', 'README.md': 'readme',
      'index.cjs': `try { require.resolve('@img/sharp-libvips-darwin-${arch}/binary'); } catch {}\nmodule.exports = require('./lib/sharp-darwin-${arch}-0.35.4.node');\n`,
      [`lib/sharp-darwin-${arch}-0.35.4.node`]: macho(arch)
    })
    pkg(macVips(arch), '1.3.3', {
      exports: { './lib': './lib/index.js', './package': './package.json', './versions': './versions.json', './binary': './lib/libvips-cpp.8.18.6.dylib' },
      os: ['darwin'], cpu: [arch]
    }, {
      'README.md': 'readme', 'versions.json': JSON.stringify({ heif: '1.23.2', vips: '8.18.6' }),
      'lib/index.js': 'module.exports = __dirname;\n', 'lib/glib-2.0/include/glibconfig.h': '// shipped header',
      'lib/libvips-cpp.8.18.6.dylib': macho(arch)
    })
  }
  for (const name of ['express-rate-limit', 'ip-address']) pkg(name, '1.0.0', {}, {})
  json(join(root, 'package-lock.json'), { lockfileVersion: 3, packages: lock })
  return {
    root, stage, resources, target, arches, source, staged, backing,
    async pack(unpack = true) {
      mkdirSync(resources, { recursive: true })
      const output = await createPackageWithOptions(stage, join(resources, 'app.asar'), unpack ? { unpackDir: 'node_modules' } : {})
      // The installed ASAR writer returns out.end(), not its finish event (despite the void typing).
      // Await its actual stream so the synchronous child cannot race buffered archive writes.
      await finished(output as unknown as Writable)
    },
    run(postSign = false) {
      const result = spawnSync(process.execPath, [join(root, 'scripts/check-packaged-runtime.mjs'), target, resources,
        `--arches=${arches.join(',')}`, ...(postSign ? ['--post-sign'] : [])], {
        encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
        env: { ...process.env, ASKTOTO_USERDATA: join(root, 'unused-profile') }
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      return result.stderr
    }
  }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function passesSharp(f: Fixture, postSign = false) {
  // The unmodified gate then deliberately stops at the next unrelated offline-asset check.
  expect(f.run(postSign)).toContain('Packaged asset is missing: ' + join(f.root, 'resources/runtime-assets-manifest.json'))
}
function rejectsSharp(f: Fixture, reason: RegExp, postSign = false) {
  const error = f.run(postSign)
  expect(error).not.toContain('runtime-assets-manifest.json')
  expect(error).toMatch(reason)
}

describe('packaged Sharp through the actual runtime gate', () => {
  it.each(['win', 'mac'] as const)('accepts reviewed %s files and builder metadata projection', async (target) => {
    const f = fixture(target); await f.pack(); passesSharp(f)
  })
  it('preserves both thin per-architecture payloads in a universal Mac package', async () => {
    const f = fixture('mac', ['arm64', 'x64']); await f.pack(); passesSharp(f)
  })
  it('does not descend into npm-installed core dependencies or their bin links', async () => {
    const f = fixture('mac')
    const { symlinkSync } = await import('node:fs')
    const dependency = f.source('sharp/node_modules/semver/bin/semver.js')
    put(dependency, 'synthetic dependency executable, never executed')
    const link = f.source('sharp/node_modules/.bin/semver')
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(process.platform === 'win32' ? dirname(dependency) : dependency, link,
      process.platform === 'win32' ? 'junction' : 'file')
    await f.pack(); passesSharp(f)
  })
  it('rejects packaged core/node_modules even when the npm source has the same dependency', async () => {
    const f = fixture()
    for (const path of [f.source('sharp/node_modules/semver/index.js'), f.staged('sharp/node_modules/semver/index.js')]) {
      put(path, 'synthetic dependency')
    }
    await f.pack(); rejectsSharp(f, /Sharp.*inventory mismatch/)
  })
  it.each(['sharp/vendor', 'sharp/dist/node_modules', `${addon}/node_modules`])('still rejects symlinks in source-owned %s', async (relative) => {
    const f = fixture()
    const { symlinkSync } = await import('node:fs')
    const outside = join(f.root, 'not-package-owned')
    put(join(outside, 'file.js'), 'synthetic source')
    const link = f.source(relative); mkdirSync(dirname(link), { recursive: true })
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    await f.pack(); rejectsSharp(f, /symlink|regular self-contained/i)
  })
  it('accepts the actual builder removal of core contributor metadata', async () => {
    const f = fixture('mac')
    editJson(f.source('sharp/package.json'), (p) => { p.contributors = ['Synthetic Fixture Contributor'] })
    await f.pack(); passesSharp(f)
  })
  it('still compares retained core metadata after the contributor projection', async () => {
    const f = fixture('mac')
    editJson(f.source('sharp/package.json'), (p) => { p.contributors = ['Synthetic Fixture Contributor']; p.description = 'Reviewed fixture' })
    editJson(f.staged('sharp/package.json'), (p) => { p.description = 'Changed fixture' })
    await f.pack(); rejectsSharp(f, /Sharp sharp package.json differs/)
  })
  it.each([winNode, winDll, `${addon}/lib/libvips-cpp-8.18.6.dll`])('rejects omitted native inventory %s', async (file) => {
    const f = fixture(); rmSync(f.staged(file)); await f.pack(); rejectsSharp(f, /inventory mismatch|Sharp.*missing/)
  })
  it('rejects a stale installed core even when the package matches that stale source', async () => {
    const f = fixture()
    for (const path of [f.source('sharp/package.json'), f.staged('sharp/package.json')]) editJson(path, (p) => { p.version = '0.35.3' })
    await f.pack(); rejectsSharp(f, /Sharp.*version|sharp.*version|reviewed Sharp/)
  })
  it('rejects an unreviewed lock version instead of treating any matching lock as patched', async () => {
    const f = fixture()
    editJson(join(f.root, 'package-lock.json'), (p) => { p.packages['node_modules/sharp'].version = '0.35.3' })
    await f.pack(); rejectsSharp(f, /lock.*sharp|Sharp.*lock|reviewed Sharp/)
  })
  it('rejects an addon lock/package mismatch', async () => {
    const f = fixture()
    editJson(join(f.root, 'package-lock.json'), (p) => { p.packages[`node_modules/${addon}`].version = '0.35.3' })
    await f.pack(); rejectsSharp(f, /lock.*sharp|Sharp.*lock|reviewed Sharp/)
  })
  it('rejects mismatched core optional dependency pairing', async () => {
    const f = fixture()
    for (const path of [f.source('sharp/package.json'), f.staged('sharp/package.json')]) editJson(path, (p) => { p.optionalDependencies[addon] = '0.35.3' })
    await f.pack(); rejectsSharp(f, /Sharp.*pair|Sharp.*dependency/)
  })
  it.each(['index.cjs', 'package.json'])('rejects redirected addon loader in %s even when source agrees', async (file) => {
    const f = fixture()
    for (const path of [f.source(`${addon}/${file}`), f.staged(`${addon}/${file}`)]) {
      if (file === 'index.cjs') put(path, "module.exports = require('./lib/old.node');\n")
      else editJson(path, (p) => { p.exports['./sharp.node'] = './elsewhere.cjs' })
    }
    await f.pack(); rejectsSharp(f, /Sharp.*loader|Sharp.*export/)
  })
  it.each(['heif', 'vips'])('rejects stale %s codec metadata even when source agrees', async (codec) => {
    const f = fixture()
    for (const path of [f.source(`${addon}/versions.json`), f.staged(`${addon}/versions.json`)]) editJson(path, (p) => { p[codec] = '0.0.1' })
    await f.pack(); rejectsSharp(f, /Sharp.*codec|Sharp.*versions/)
  })
  it.each(['@img/sharp-libvips-win32-x64', '@img/sharp-win32-arm64', '@img/sharp-linuxmusl-x64'])('rejects stale/foreign %s', async (name) => {
    const f = fixture(); json(f.staged(`${name}/package.json`), { name, version: '0.35.4' })
    await f.pack(); rejectsSharp(f, /Sharp.*unexpected|Sharp.*foreign/)
  })
  it('rejects a foreign Sharp package present only in ASAR', async () => {
    const f = fixture(); json(f.staged('@img/sharp-win32-ia32/package.json'), { name: '@img/sharp-win32-ia32', version: '0.35.4' })
    await f.pack(false)
    for (const name of ['sharp', addon]) {
      const { cpSync } = await import('node:fs'); cpSync(f.staged(name), f.backing(name), { recursive: true })
    }
    rejectsSharp(f, /Sharp.*unexpected|Sharp.*foreign/)
  })
  it('rejects a nested alternative Sharp copy in ASAR', async () => {
    const f = fixture(); json(f.staged('other/node_modules/sharp/package.json'), { name: 'sharp', version: '0.35.3' })
    await f.pack(); rejectsSharp(f, /Sharp.*unexpected|Sharp.*nested/)
  })
  it('rejects unpacked backing that is not declared unpacked by ASAR', async () => {
    const f = fixture(); await f.pack(false)
    const { cpSync } = await import('node:fs')
    for (const name of ['sharp', addon]) cpSync(f.staged(name), f.backing(name), { recursive: true })
    rejectsSharp(f, /Sharp.*unpacked/)
  })
  it('rejects a native file omitted from ASAR despite physical backing', async () => {
    const f = fixture(); rmSync(f.staged(winNode)); await f.pack(); put(f.backing(winNode), pe())
    rejectsSharp(f, /Sharp.*ASAR|Sharp.*asar/)
  })
  it('rejects unreviewed native code in the Sharp core even if the source also contains it', async () => {
    const f = fixture(); put(f.source('sharp/dist/extra.node'), pe()); put(f.staged('sharp/dist/extra.node'), pe())
    await f.pack(); rejectsSharp(f, /Sharp.*native.*inventory|Sharp.*unexpected.*native/)
  })
  it('rejects ASAR directory aliases even when the header also lists plausible regular children', async () => {
    const f = fixture(); await f.pack()
    const archive = join(f.resources, 'app.asar')
    const header = getRawHeader(archive).header as any
    header.files.node_modules.files.sharp.link = 'node_modules/elsewhere'
    // All fixture files are unpacked: rebuild only the two standard ASAR pickles, no payload bytes.
    const encoded = Buffer.from(JSON.stringify(header))
    const padded = Math.ceil(encoded.length / 4) * 4
    const bytes = Buffer.alloc(16 + padded)
    bytes.writeUInt32LE(4, 0); bytes.writeUInt32LE(8 + padded, 4)
    bytes.writeUInt32LE(4 + padded, 8); bytes.writeUInt32LE(encoded.length, 12); encoded.copy(bytes, 16)
    put(archive, bytes)
    rejectsSharp(f, /Sharp.*ASAR.*directory|Sharp.*ASAR.*link/)
  })
  it('rejects a missing unpacked backing file', async () => {
    const f = fixture(); await f.pack(); rmSync(f.backing(winNode))
    rejectsSharp(f, /dangling unpacked reference|missing/)
  })
  it('rejects a symlinked package ancestor', async () => {
    const f = fixture(); await f.pack()
    const { renameSync, symlinkSync } = await import('node:fs')
    const path = join(f.resources, 'app.asar.unpacked/node_modules/@img')
    const outside = join(f.root, 'outside-img'); renameSync(path, outside)
    symlinkSync(outside, path, process.platform === 'win32' ? 'junction' : 'dir')
    rejectsSharp(f, /real directory|symlink/)
  })
  it.each([winNode, winDll, `${addon}/lib/libvips-cpp-8.18.6.dll`].flatMap((file) => [0x14c, 0xaa64].map((machine) => ({ file, machine }))))('rejects wrong PE architecture $machine in $file even when source bytes agree', async ({ file, machine }) => {
    const f = fixture(); put(f.source(file), pe(machine)); put(f.staged(file), pe(machine))
    await f.pack(); rejectsSharp(f, /expected PE x64/)
  })
  it.each([false, true])('keeps Windows native hashes enforced postSign=%s', async (postSign) => {
    const f = fixture(); await f.pack()
    const bytes = pe(); bytes[80] = 1; put(f.backing(winDll), bytes)
    rejectsSharp(f, /SHA-256 mismatch/, postSign)
  })
  it('rejects a missing universal Mac architecture', async () => {
    const f = fixture('mac', ['arm64', 'x64']); rmSync(f.staged(macVips('x64')), { recursive: true })
    await f.pack(); rejectsSharp(f, /missing|Sharp.*ASAR/)
  })
  it('rejects stale Darwin libvips pairing', async () => {
    const f = fixture('mac')
    for (const path of [f.source(`${macAddon('arm64')}/package.json`), f.staged(`${macAddon('arm64')}/package.json`)]) editJson(path, (p) => { p.optionalDependencies[macVips('arm64')] = '1.3.2' })
    await f.pack(); rejectsSharp(f, /Sharp.*pair|Sharp.*dependency/)
  })
  it('rejects a redirected Darwin libvips binary export', async () => {
    const f = fixture('mac')
    for (const path of [f.source(`${macVips('arm64')}/package.json`), f.staged(`${macVips('arm64')}/package.json`)]) editJson(path, (p) => { p.exports['./binary'] = './lib/old.dylib' })
    await f.pack(); rejectsSharp(f, /Sharp.*export/)
  })
  it.each([macNode('arm64'), macDylib('arm64')].flatMap((file) => [false, true].map((postSign) => ({ file, postSign }))))('rejects a wrong Darwin slice in $file postSign=$postSign', async ({ file, postSign }) => {
    const f = fixture('mac'); put(f.source(file), macho('x64')); put(f.staged(file), macho('x64'))
    await f.pack(); rejectsSharp(f, /expected Mach-O arches/, postSign)
  })
  it('requires exact pre-sign Mac bytes', async () => {
    const f = fixture('mac'); await f.pack()
    const bytes = macho('arm64'); bytes[50] = 1; put(f.backing(macDylib('arm64')), bytes)
    rejectsSharp(f, /SHA-256 mismatch/)
  })
  it('allows only Mac native-byte mutation after signing; existing later codesign remains responsible', async () => {
    const f = fixture('mac', ['arm64', 'x64']); await f.pack()
    for (const arch of ['arm64', 'x64']) for (const path of [macNode(arch), macDylib(arch)]) {
      const bytes = Buffer.concat([macho(arch), Buffer.from('synthetic-signature')]); put(f.backing(path), bytes)
    }
    passesSharp(f, true)
    const loaderPath = f.backing(`${macAddon('arm64')}/index.cjs`)
    const loader = readFileSync(loaderPath); loader[10] ^= 1; put(loaderPath, loader)
    rejectsSharp(f, /SHA-256 mismatch/, true)
  })
})
