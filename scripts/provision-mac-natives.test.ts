import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { provisionMacNatives } from './provision-mac-natives.mjs'

type Arch = 'arm64' | 'x64'

const SHARP_VERSION = '0.35.4'
const SHERPA_VERSION = '1.13.3'
const LIBVIPS: Record<Arch, string> = { arm64: '1.3.3', x64: '1.3.4' }
const arches: Arch[] = ['arm64', 'x64']
const scratch: string[] = []

afterEach(() => {
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true })
})

function packageDir(root: string, name: string): string {
  return join(root, 'node_modules', name)
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}

function writePackage(root: string, name: string, value: Record<string, unknown>): void {
  writeJson(join(packageDir(root, name), 'package.json'), { name, ...value })
}

function makeFixture(options: {
  hostArch?: Arch
  hostLibVersion?: string
  x64LockPair?: string
} = {}): { root: string; hostArch: Arch } {
  const root = mkdtempSync(join(tmpdir(), 'metis-mac-natives-'))
  scratch.push(root)
  const hostArch = options.hostArch ?? 'arm64'
  const sharpOptional: Record<string, string> = {}
  const packages: Record<string, unknown> = {
    'node_modules/sharp': { version: SHARP_VERSION, optionalDependencies: sharpOptional }
  }

  for (const arch of arches) {
    const addon = `@img/sharp-darwin-${arch}`
    const libvips = `@img/sharp-libvips-darwin-${arch}`
    sharpOptional[addon] = SHARP_VERSION
    sharpOptional[libvips] = LIBVIPS[arch]
    packages[`node_modules/${addon}`] = {
      version: SHARP_VERSION,
      optionalDependencies: { [libvips]: arch === 'x64' ? options.x64LockPair ?? LIBVIPS[arch] : LIBVIPS[arch] }
    }
    packages[`node_modules/${libvips}`] = { version: LIBVIPS[arch] }
  }

  writePackage(root, 'sharp', { version: SHARP_VERSION, optionalDependencies: sharpOptional })
  writePackage(root, 'sherpa-onnx-node', { version: SHERPA_VERSION })
  const hostAddon = `@img/sharp-darwin-${hostArch}`
  const hostLibvips = `@img/sharp-libvips-darwin-${hostArch}`
  writePackage(root, hostAddon, {
    version: SHARP_VERSION,
    optionalDependencies: { [hostLibvips]: LIBVIPS[hostArch] },
    exports: { './sharp.node': './index.cjs' }
  })
  writePackage(root, hostLibvips, {
    version: options.hostLibVersion ?? LIBVIPS[hostArch],
    exports: { './binary': './lib/libvips-cpp.host.dylib' }
  })
  writeJson(join(root, 'package-lock.json'), { lockfileVersion: 3, packages })
  return { root, hostArch }
}

function writeProvisioned(root: string, options: {
  omitAddon?: Arch
  staleAddonFile?: Arch
  staleAddonManifest?: Arch
  wrongLoader?: Arch
  wrongDylibExport?: Arch
  omitDylib?: Arch
  omitSherpa?: Arch
} = {}): void {
  for (const arch of arches) {
    const addon = `@img/sharp-darwin-${arch}`
    const libvips = `@img/sharp-libvips-darwin-${arch}`
    const addonVersion = options.staleAddonManifest === arch ? '0.35.3' : SHARP_VERSION
    writePackage(root, addon, {
      version: addonVersion,
      optionalDependencies: { [libvips]: LIBVIPS[arch] },
      exports: { './sharp.node': './index.cjs' }
    })
    const loaderVersion = options.wrongLoader === arch ? '0.35.3' : SHARP_VERSION
    writeFileSync(
      join(packageDir(root, addon), 'index.cjs'),
      `try { require.resolve('${libvips}/binary'); } catch {}\n` +
        `module.exports = require('./lib/sharp-darwin-${arch}-${loaderVersion}.node');\n`
    )
    if (options.omitAddon !== arch) {
      const fileVersion = options.staleAddonFile === arch ? '0.35.3' : SHARP_VERSION
      const addonFile = join(packageDir(root, addon), 'lib', `sharp-darwin-${arch}-${fileVersion}.node`)
      mkdirSync(dirname(addonFile), { recursive: true })
      writeFileSync(addonFile, 'fixture')
    }

    const binary = options.wrongDylibExport === arch
      ? './lib/libvips-cpp.8.17.0.dylib'
      : './lib/libvips-cpp.8.18.6.dylib'
    writePackage(root, libvips, { version: LIBVIPS[arch], exports: { './binary': binary } })
    writeJson(join(packageDir(root, libvips), 'versions.json'), { vips: '8.18.6' })
    if (options.omitDylib !== arch) {
      const dylib = join(packageDir(root, libvips), binary)
      mkdirSync(dirname(dylib), { recursive: true })
      writeFileSync(dylib, 'fixture')
    }

    if (options.omitSherpa !== arch) {
      const sherpaAddon = join(packageDir(root, `sherpa-onnx-darwin-${arch}`), 'sherpa-onnx.node')
      mkdirSync(dirname(sherpaAddon), { recursive: true })
      writeFileSync(sherpaAddon, 'fixture', {
        flag: 'w'
      })
    }
  }
}

function provision(root: string, hostArch: Arch, run: ReturnType<typeof vi.fn>) {
  return provisionMacNatives({ root, hostArch, platform: 'darwin', run, log: vi.fn() })
}

describe('provisionMacNatives', () => {
  it('derives each reviewed Sharp pair and keeps both arches plus Sherpa in one npm install', () => {
    const fixture = makeFixture()
    const run = vi.fn(() => writeProvisioned(fixture.root))

    expect(provision(fixture.root, fixture.hostArch, run)).toEqual({
      sharpVersion: SHARP_VERSION,
      sherpaVersion: SHERPA_VERSION,
      packages: [
        `sherpa-onnx-darwin-arm64@${SHERPA_VERSION}`,
        `sherpa-onnx-darwin-x64@${SHERPA_VERSION}`,
        `@img/sharp-darwin-arm64@${SHARP_VERSION}`,
        `@img/sharp-darwin-x64@${SHARP_VERSION}`,
        `@img/sharp-libvips-darwin-arm64@${LIBVIPS.arm64}`,
        `@img/sharp-libvips-darwin-x64@${LIBVIPS.x64}`
      ]
    })
    expect(run).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledWith(
      'npm',
      ['install', '--no-save', '--force',
        `sherpa-onnx-darwin-arm64@${SHERPA_VERSION}`,
        `sherpa-onnx-darwin-x64@${SHERPA_VERSION}`,
        `@img/sharp-darwin-arm64@${SHARP_VERSION}`,
        `@img/sharp-darwin-x64@${SHARP_VERSION}`,
        `@img/sharp-libvips-darwin-arm64@${LIBVIPS.arm64}`,
        `@img/sharp-libvips-darwin-x64@${LIBVIPS.x64}`],
      { cwd: fixture.root, stdio: 'inherit', shell: false }
    )
  })

  it('rejects a stale installed host libvips pair before invoking npm', () => {
    const fixture = makeFixture({ hostLibVersion: '1.3.2' })
    const run = vi.fn()

    expect(() => provision(fixture.root, fixture.hostArch, run)).toThrow(
      '@img/sharp-libvips-darwin-arm64 installed version 1.3.2 does not match Sharp 0.35.4 required version 1.3.3.'
    )
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects stale addon-to-libvips lock pairing before invoking npm', () => {
    const fixture = makeFixture({ x64LockPair: '1.3.2' })
    const run = vi.fn()

    expect(() => provision(fixture.root, fixture.hostArch, run)).toThrow(
      '@img/sharp-darwin-x64 lock pairing 1.3.2 does not match Sharp required @img/sharp-libvips-darwin-x64 1.3.4.'
    )
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects a stale Sharp-core lock pairing before invoking npm', () => {
    const fixture = makeFixture()
    const lockPath = join(fixture.root, 'package-lock.json')
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
    lock.packages['node_modules/sharp'].optionalDependencies['@img/sharp-libvips-darwin-x64'] = '1.3.2'
    writeJson(lockPath, lock)
    const run = vi.fn()

    expect(() => provision(fixture.root, fixture.hostArch, run)).toThrow(
      'Sharp lock requirement @img/sharp-libvips-darwin-x64 1.3.2 does not match installed core requirement 1.3.4.'
    )
    expect(run).not.toHaveBeenCalled()
  })

  it.each([
    ['missing exact x64 addon', { omitAddon: 'x64' as Arch }, /missing exact addon.*sharp-darwin-x64-0\.35\.4\.node/i],
    ['only stale x64 addon', { staleAddonFile: 'x64' as Arch }, /missing exact addon.*sharp-darwin-x64-0\.35\.4\.node/i],
    ['stale x64 addon manifest', { staleAddonManifest: 'x64' as Arch }, /installed version 0\.35\.3.*required version 0\.35\.4/i],
    ['wrong x64 loader target', { wrongLoader: 'x64' as Arch }, /loader target.*sharp-darwin-x64-0\.35\.4\.node/i],
    ['wrong x64 dylib export', { wrongDylibExport: 'x64' as Arch }, /binary export.*libvips-cpp\.8\.18\.6\.dylib/i],
    ['missing x64 dylib', { omitDylib: 'x64' as Arch }, /missing declared dylib.*libvips-cpp\.8\.18\.6\.dylib/i],
    ['missing x64 Sherpa addon', { omitSherpa: 'x64' as Arch }, /missing after install[\s\S]*sherpa-onnx-darwin-x64\/sherpa-onnx\.node/i]
  ])('fails when the one-shot install leaves %s', (_label, postcondition, expected) => {
    const fixture = makeFixture()
    const run = vi.fn(() => writeProvisioned(fixture.root, postcondition))

    expect(() => provision(fixture.root, fixture.hostArch, run)).toThrow(expected)
    expect(run).toHaveBeenCalledOnce()
  })

  it('fails closed when npm installation fails and does not inspect a claimed success tree', () => {
    const fixture = makeFixture()
    const run = vi.fn(() => { throw new Error('resolution failed') })

    expect(() => provision(fixture.root, fixture.hostArch, run)).toThrow(
      'provision-mac-natives npm install failed: resolution failed'
    )
    expect(run).toHaveBeenCalledOnce()
    expect(() => readFileSync(join(packageDir(fixture.root, '@img/sharp-darwin-x64'), 'index.cjs'))).toThrow()
  })

  it.each([
    ['addon directory', '@img/sharp-darwin-x64/lib/sharp-darwin-x64-0.35.4.node', true],
    ['empty addon', '@img/sharp-darwin-x64/lib/sharp-darwin-x64-0.35.4.node', false],
    ['dylib directory', '@img/sharp-libvips-darwin-x64/lib/libvips-cpp.8.18.6.dylib', true],
    ['empty dylib', '@img/sharp-libvips-darwin-x64/lib/libvips-cpp.8.18.6.dylib', false]
  ])('rejects a nominal native path that is an %s', (_label, relativePath, directory) => {
    const fixture = makeFixture()
    const run = vi.fn(() => {
      writeProvisioned(fixture.root)
      const file = join(fixture.root, 'node_modules', relativePath)
      rmSync(file)
      if (directory) mkdirSync(file)
      else writeFileSync(file, '')
    })
    expect(() => provision(fixture.root, fixture.hostArch, run)).toThrow(/missing (exact addon|declared dylib)/)
  })

  it('refuses an install that changed the core version after the pair was selected', () => {
    const fixture = makeFixture()
    const run = vi.fn(() => {
      writeProvisioned(fixture.root)
      const path = join(packageDir(fixture.root, 'sharp'), 'package.json')
      const core = JSON.parse(readFileSync(path, 'utf8'))
      writeJson(path, { ...core, version: '0.35.5' })
    })
    expect(() => provision(fixture.root, fixture.hostArch, run)).toThrow(
      'Sharp lock version 0.35.4 does not match installed version 0.35.5.'
    )
  })

  it('refuses a consistent but different lock/core pairing introduced during installation', () => {
    const fixture = makeFixture()
    const run = vi.fn(() => {
      writeProvisioned(fixture.root)
      const path = join(packageDir(fixture.root, 'sharp'), 'package.json')
      const core = JSON.parse(readFileSync(path, 'utf8'))
      const lockPath = join(fixture.root, 'package-lock.json')
      const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
      const lib = '@img/sharp-libvips-darwin-x64'
      core.optionalDependencies[lib] = '1.3.5'
      lock.packages['node_modules/sharp'].optionalDependencies[lib] = '1.3.5'
      lock.packages['node_modules/@img/sharp-darwin-x64'].optionalDependencies[lib] = '1.3.5'
      lock.packages[`node_modules/${lib}`].version = '1.3.5'
      writeJson(path, core)
      writeJson(lockPath, lock)
    })
    expect(() => provision(fixture.root, fixture.hostArch, run)).toThrow(
      'Sharp dependency graph changed during native provisioning.'
    )
  })
})
