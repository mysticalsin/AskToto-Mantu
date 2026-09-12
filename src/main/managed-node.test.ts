import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

vi.mock('electron')

import { app } from 'electron'
import {
  MANAGED_NODE_ASSETS,
  MANAGED_NODE_VERSION,
  extractManagedNodeArchiveArgs,
  managedNodeDistUrl,
  managedNodeInnerFolderName,
  managedNodePlatformKey,
  resolveManagedNode,
  windowsPackIncludesManagedNode,
  windowsPackIncludesVcRedist,
  vcredistQuietArgs
} from './managed-node'

const builderYml = readFileSync(join(__dirname, '../../electron-builder.yml'), 'utf8')
const packageJson = readFileSync(join(__dirname, '../../package.json'), 'utf8')
const scratch: string[] = []
const processDescriptors = new Map(
  ['platform', 'arch', 'resourcesPath'].map((key) => [key, Object.getOwnPropertyDescriptor(process, key)])
)

afterEach(() => {
  for (const [key, descriptor] of processDescriptors) {
    if (descriptor) Object.defineProperty(process, key, descriptor)
    else Reflect.deleteProperty(process, key)
  }
  vi.restoreAllMocks()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function winExtraResourcesFromYml(yml: string): { from: string; to: string }[] {
  // Windows CI checkouts may rewrite LF → CRLF. `^win:\n` then misses the win: block and the
  // extraResources pin silently reports managed-node / vcredist as absent.
  const normalized = yml.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const win = normalized.split(/^win:\n/m)[1] || ''
  const extra = win.split(/extraResources:\n/)[1] || ''
  const block = extra.split(/\n  [a-z]/)[0]
  const froms = [...block.matchAll(/from:\s+(\S+)/g)].map((m) => m[1])
  const tos = [...block.matchAll(/to:\s+(\S+)/g)].map((m) => m[1])
  return froms.map((from, i) => ({ from, to: tos[i] || '' }))
}

describe('Windows packaging does not require a preinstalled Node', () => {
  it('electron-builder ships managed-node and vcredist as extraResources', () => {
    const extras = winExtraResourcesFromYml(builderYml)
    expect(windowsPackIncludesManagedNode(extras)).toBe(true)
    expect(windowsPackIncludesVcRedist(extras)).toBe(true)
    expect(builderYml).toContain('resources/managed-node/win-x64')
    expect(builderYml).toContain('managed-node/win-x64')
  })

  it('still finds managed-node and vcredist when the yml is a Windows CRLF checkout', () => {
    const lf = builderYml.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const extras = winExtraResourcesFromYml(lf.replace(/\n/g, '\r\n'))
    expect(windowsPackIncludesManagedNode(extras)).toBe(true)
    expect(windowsPackIncludesVcRedist(extras)).toBe(true)
  })

  it('predist:win fetches the portable Node so the next pack includes it', () => {
    expect(packageJson).toContain('fetch-managed-node.mjs win')
    expect(packageJson).toContain('fetch-managed-node.mjs mac')
  })

  it('mac extraResources also ship portable Node for the next DMG', () => {
    expect(builderYml).toContain('resources/managed-node/darwin-arm64')
    expect(builderYml).toContain('managed-node/darwin-arm64')
  })

  it('mac universal x64ArchFiles includes managed-node so identical sidecars do not abort lipo', () => {
    const rule = builderYml.match(/x64ArchFiles:\s*'([^']+)'/)?.[1] ?? ''
    expect(rule).toContain('managed-node')
  })

  it('installManagedNodeFromArchive unpacks a real tar.gz into dest without a system node', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync, chmodSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { execFileSync } = await import('node:child_process')
    const { installManagedNodeFromArchive } = await import('./managed-node')
    const dir = mkdtempSync(join(tmpdir(), 'managed-node-extract-'))
    const inner = join(dir, 'node-v22.22.3-darwin-arm64', 'bin')
    mkdirSync(inner, { recursive: true })
    const fakeNode = join(inner, 'node')
    writeFileSync(fakeNode, '#!/bin/sh\necho ok\n')
    chmodSync(fakeNode, 0o755)
    const archive = join(dir, 'node.tar.gz')
    execFileSync('tar', ['-czf', archive, '-C', dir, 'node-v22.22.3-darwin-arm64'])
    const dest = join(dir, 'out')
    try {
      await installManagedNodeFromArchive(archive, dest)
      expect(existsSync(join(dest, 'bin', 'node'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('extract uses OS tar, never a PATH node binary', () => {
    const zip = extractManagedNodeArchiveArgs('/tmp/node.zip', '/tmp/out')
    expect(zip.args).toContain('-xf')
    expect(zip.command).not.toBe('node')
    expect(zip.command).not.toMatch(/[/\\]usr[/\\]bin[/\\]node$/)
    const tgz = extractManagedNodeArchiveArgs('/tmp/node.tar.gz', '/tmp/out')
    expect(tgz.command).toBe('tar')
    expect(tgz.args).toContain('--strip-components=1')
    expect(managedNodeInnerFolderName('node-v22.22.3-win-x64.zip')).toBe('node-v22.22.3-win-x64')
  })

  it('resolveManagedNode never consults PATH / a system node binary name', () => {
    const src = readFileSync(join(__dirname, 'managed-node.ts'), 'utf8')
    expect(src).not.toMatch(/process\.env\.PATH/)
    expect(src).not.toMatch(/command -v node/)
    expect(src).not.toMatch(/where\.exe.*node/)
    const resolved = resolveManagedNode()
    if (resolved) {
      expect(resolved.node).not.toBe('node')
      expect(resolved.node).not.toMatch(/[/\\]usr[/\\]bin[/\\]node$/)
    }
  })

  it('MQA-314: pins supported official Node 24.21.0 and a quiet VC++ install', () => {
    expect(MANAGED_NODE_VERSION).toBe('24.21.0')
    expect(managedNodeDistUrl('node-v24.21.0-win-x64.zip')).toBe(
      'https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip'
    )
    expect(managedNodePlatformKey('win32', 'x64')).toBe('win32-x64')
    expect(vcredistQuietArgs()).toEqual(['/install', '/quiet', '/norestart'])
  })

  it('satisfies the Node floor of the locked Dust SDK used by the managed Dust CLI', () => {
    const lock = JSON.parse(readFileSync(join(__dirname, '../../package-lock.json'), 'utf8'))
    const requirement = lock.packages['node_modules/@dust-tt/client'].engines.node
    expect(requirement).toMatch(/^>=\d+\.\d+\.\d+$/)
    const required = requirement.slice(2).split('.').map(Number)
    const bundled = MANAGED_NODE_VERSION.split('.').map(Number)
    const firstDifference = bundled.findIndex((part, index) => part !== required[index])
    expect(firstDifference === -1 || bundled[firstDifference] > required[firstDifference]).toBe(true)
  })

  it('uses the same manifest for runtime resolution and all installer downloads', () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, '../shared/managed-node-manifest.json'), 'utf8'))
    expect(MANAGED_NODE_VERSION).toBe(manifest.version)
    expect(MANAGED_NODE_ASSETS).toEqual(manifest.assets)
    const provisioner = readFileSync(join(__dirname, '../../scripts/fetch-managed-node.mjs'), 'utf8')
    expect(provisioner).toContain('managed-node-manifest.json')
    expect(Object.keys(manifest.assets).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'win32-x64'])
    for (const [key, value] of Object.entries(manifest.assets)) {
      const spec = value as { file: string; sha256: string }
      expect(spec.file).toContain(`node-v${manifest.version}-${key.replace('win32-', 'win-')}`)
      expect(spec.sha256).toMatch(/^[a-f0-9]{64}$/)
    }
  })

  it.each([
    ['win32', 'x64', 'win-x64', 'node.exe'],
    ['darwin', 'arm64', 'darwin-arm64', 'bin/node'],
    ['darwin', 'x64', 'darwin-x64', 'bin/node']
  ])('rejects stale or unmarked packaged Node on %s %s and accepts only the pinned runtime', (platform, arch, dir, nodeRel) => {
    const fixture = mkdtempSync(join(tmpdir(), 'metis-managed-node-version-'))
    scratch.push(fixture)
    Object.defineProperty(process, 'platform', { configurable: true, value: platform })
    Object.defineProperty(process, 'arch', { configurable: true, value: arch })
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: join(fixture, 'resources') })
    vi.mocked(app.getPath).mockImplementation(() => join(fixture, 'userData'))
    const root = join(fixture, 'resources', 'managed-node', dir)
    mkdirSync(dirname(join(root, nodeRel)), { recursive: true })
    writeFileSync(join(root, nodeRel), 'fixture binary')
    expect(resolveManagedNode()).toBeNull()
    writeFileSync(join(root, '.node-version'), '22.22.3\n')
    expect(resolveManagedNode()).toBeNull()
    const cacheRoot = join(fixture, 'userData', 'managed-node', MANAGED_NODE_VERSION, dir)
    mkdirSync(dirname(join(cacheRoot, nodeRel)), { recursive: true })
    writeFileSync(join(cacheRoot, nodeRel), 'downloaded binary fixture')
    writeFileSync(join(cacheRoot, '.node-version'), '22.22.3\n')
    expect(resolveManagedNode()).toBeNull()
    writeFileSync(join(cacheRoot, '.node-version'), `${MANAGED_NODE_VERSION}\n`)
    expect(resolveManagedNode()).toMatchObject({ node: join(cacheRoot, nodeRel), source: 'userData' })
    writeFileSync(join(root, '.node-version'), `${MANAGED_NODE_VERSION}\n`)
    expect(resolveManagedNode()).toMatchObject({ node: join(root, nodeRel), source: 'packaged' })
  })
})
