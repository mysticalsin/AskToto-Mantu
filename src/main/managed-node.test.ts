import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('electron')

import {
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

function winExtraResourcesFromYml(yml: string): { from: string; to: string }[] {
  // Windows CI checkouts may rewrite LF → CRLF. `^win:\n` then misses the win: block and the
  // extraResources pin silently reports managed-node / vcredist as absent.
  // Strip every CR — not only `\r\n`. A naive `\n` → `\r\n` on an already-CRLF checkout
  // (windows-latest + core.autocrlf) produces `\r\r\n`; replacing only `\r\n` leaves a
  // leftover `\r` and the win: split still fails.
  const normalized = yml.replace(/\r/g, '')
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
    // On windows-latest the checkout is already CRLF, so this replace yields `\r\r\n`.
    // The parser must still find the extraResources pin (do not drop the assertion).
    const extras = winExtraResourcesFromYml(builderYml.replace(/\n/g, '\r\n'))
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

  it('pins official Node 22.22.3 and a quiet VC++ install', () => {
    expect(MANAGED_NODE_VERSION).toBe('22.22.3')
    expect(managedNodeDistUrl('node-v22.22.3-win-x64.zip')).toBe(
      'https://nodejs.org/dist/v22.22.3/node-v22.22.3-win-x64.zip'
    )
    expect(managedNodePlatformKey('win32', 'x64')).toBe('win32-x64')
    expect(vcredistQuietArgs()).toEqual(['/install', '/quiet', '/norestart'])
  })
})
