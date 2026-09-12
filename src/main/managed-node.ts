/**
 * Vendored portable Node for managed CLIs that need a real Node ABI (Dust CLI + keytar).
 *
 * ELECTRON_RUN_AS_NODE boots Electron's own binary as a JS runtime — that is enough for the
 * self-contained Claude/Codex entry scripts. @dust-tt/dust-cli statically imports `keytar`, a
 * native addon compiled for official Node's NODE_MODULE_VERSION, not Electron's. Spawning Dust
 * under Electron-as-node therefore fails to load keytar. This module resolves a pinned official
 * Node from the shared managed-runtime manifest (compatible with Dust's engine requirement),
 * independently of the build toolchain, from extraResources or userData so the user
 * never installs Node, Git, or VC++ themselves.
 *
 * Windows packaging copies resources/managed-node/win-x64 → extraResources. First-run / Set up
 * Dust can also fetch the official zip into userData if the pack omitted it (dev checkouts).
 */

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import managedNodeManifest from '@shared/managed-node-manifest.json'

export const MANAGED_NODE_VERSION = managedNodeManifest.version
export const MANAGED_NODE_ASSETS = managedNodeManifest.assets

export type ManagedNodePlatform = keyof typeof MANAGED_NODE_ASSETS

export function managedNodePlatformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): ManagedNodePlatform | null {
  if (platform === 'win32' && arch === 'x64') return 'win32-x64'
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64'
  if (platform === 'darwin' && (arch === 'x64' || arch === 'amd64')) return 'darwin-x64'
  return null
}

export function managedNodeDistUrl(file: string): string {
  return `https://nodejs.org/dist/v${MANAGED_NODE_VERSION}/${file}`
}

/** Packaged extraResources root (next pack). Dev checkouts have this under resources/. */
export function packagedManagedNodeRoot(): string | null {
  try {
    const resources = process.resourcesPath || ''
    if (resources) {
      const win = join(resources, 'managed-node', 'win-x64')
      const mac = join(resources, 'managed-node', `${process.platform}-${process.arch}`)
      if (process.platform === 'win32' && existsSync(join(win, 'node.exe'))) return win
      if (existsSync(join(mac, 'bin', 'node'))) return mac
    }
  } catch {
    /* unpackaged */
  }
  return null
}

export function userDataManagedNodeRoot(): string {
  const key = managedNodePlatformKey()
  const dir = key === 'win32-x64' ? 'win-x64' : key || `${process.platform}-${process.arch}`
  return join(app.getPath('userData'), 'managed-node', MANAGED_NODE_VERSION, dir)
}

export interface ManagedNodeCommand {
  node: string
  npm: string
  source: 'packaged' | 'userData'
}

function nodeAndNpmAt(root: string, key: ManagedNodePlatform | null): ManagedNodeCommand | null {
  if (readManagedNodeMarker(root) !== MANAGED_NODE_VERSION) return null
  if (!key) {
    const winNode = join(root, 'node.exe')
    const macNode = join(root, 'bin', 'node')
    if (existsSync(winNode)) return { node: winNode, npm: join(root, 'npm.cmd'), source: 'userData' }
    if (existsSync(macNode)) return { node: macNode, npm: join(root, 'bin', 'npm'), source: 'userData' }
    return null
  }
  const spec = MANAGED_NODE_ASSETS[key]
  const node = join(root, spec.nodeRelPath)
  const npm = join(root, spec.npmRelPath)
  if (!existsSync(node)) return null
  return { node, npm, source: 'userData' }
}

/**
 * Resolve a portable Node that can load native addons. Never requires a preinstalled system Node
 * on PATH — that is the Windows "seamless" contract.
 */
export function resolveManagedNode(): ManagedNodeCommand | null {
  const packaged = packagedManagedNodeRoot()
  if (packaged) {
    const found = nodeAndNpmAt(packaged, managedNodePlatformKey())
    if (found) return { ...found, source: 'packaged' }
  }
  return nodeAndNpmAt(userDataManagedNodeRoot(), managedNodePlatformKey())
}

/** True when Windows packaging extraResources is wired so the next pack ships Node (no PATH Node). */
export function windowsPackIncludesManagedNode(extraResources: readonly { from?: string; to?: string }[]): boolean {
  return extraResources.some(
    (r) =>
      typeof r.from === 'string' &&
      typeof r.to === 'string' &&
      /managed-node[/\\]win/.test(r.from.replace(/\\/g, '/')) &&
      /managed-node/.test(r.to.replace(/\\/g, '/'))
  )
}

export function windowsPackIncludesVcRedist(extraResources: readonly { from?: string; to?: string }[]): boolean {
  return extraResources.some(
    (r) =>
      typeof r.from === 'string' &&
      typeof r.to === 'string' &&
      /vcredist/.test(r.from.replace(/\\/g, '/')) &&
      /vcredist/.test(r.to.replace(/\\/g, '/'))
  )
}

export function verifySha256(buf: Buffer, expectedHex: string): void {
  const actual = createHash('sha256').update(buf).digest('hex')
  if (actual !== expectedHex) {
    throw new Error(`managed Node integrity check failed — sha256 ${actual} !== ${expectedHex}`)
  }
}

export function managedNodeMarkerPath(root: string): string {
  return join(root, '.node-version')
}

export function writeManagedNodeMarker(root: string, version: string = MANAGED_NODE_VERSION): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(managedNodeMarkerPath(root), version + '\n', 'utf8')
}

export function readManagedNodeMarker(root: string): string | null {
  try {
    return readFileSync(managedNodeMarkerPath(root), 'utf8').trim() || null
  } catch {
    return null
  }
}

/** Atomic promote of a downloaded extract into the userData Node root. */
/** Silent VC++ install from extraResources / userData. No-op if the exe is absent or not Windows. */
export function vcredistExePath(): string | null {
  const candidates = [
    join(process.resourcesPath || '', 'vcredist', 'vc_redist.x64.exe'),
    join(app.getPath('userData'), 'vcredist', 'vc_redist.x64.exe')
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

export function vcredistQuietArgs(): string[] {
  return ['/install', '/quiet', '/norestart']
}

export function promoteManagedNodeExtract(tmpDir: string, destRoot: string): void {
  mkdirSync(dirname(destRoot), { recursive: true })
  rmSync(destRoot, { recursive: true, force: true })
  renameSync(tmpDir, destRoot)
  writeManagedNodeMarker(destRoot)
}

/** OS `tar` / Windows `tar.exe` — never a user-installed Node, Git, or npm. */
export function extractManagedNodeArchiveArgs(
  archivePath: string,
  dest: string
): { command: string; args: string[] } {
  if (archivePath.endsWith('.zip')) {
    const tar =
      process.platform === 'win32'
        ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
        : 'tar'
    return { command: tar, args: ['-xf', archivePath, '-C', dest] }
  }
  return { command: 'tar', args: ['-xzf', archivePath, '-C', dest, '--strip-components=1'] }
}

export function managedNodeInnerFolderName(file: string): string {
  return file.replace(/\.zip$/i, '').replace(/\.tar\.gz$/i, '')
}

function spawnExtract(archivePath: string, dest: string): Promise<void> {
  const spec = extractManagedNodeArchiveArgs(archivePath, dest)
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, { windowsHide: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`managed Node extract failed (${spec.command} exit ${code})`))
        return
      }
      resolve()
    })
  })
}

/** Unpack a verified official Node archive into destRoot (the folder that will contain node.exe / bin/node). */
export async function installManagedNodeFromArchive(archivePath: string, destRoot: string): Promise<void> {
  const tmp = `${destRoot}.tmp-${randomBytes(6).toString('hex')}`
  mkdirSync(tmp, { recursive: true })
  try {
    await spawnExtract(archivePath, tmp)
    const inner = join(tmp, managedNodeInnerFolderName(archivePath.split(/[/\\]/).pop() || ''))
    const promoteFrom =
      existsSync(join(inner, 'node.exe')) || existsSync(join(inner, 'bin', 'node')) ? inner : tmp
    if (promoteFrom === inner) {
      promoteManagedNodeExtract(inner, destRoot)
      rmSync(tmp, { recursive: true, force: true })
    } else {
      promoteManagedNodeExtract(tmp, destRoot)
    }
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true })
    throw e
  }
}

/**
 * Resolve packaged extraResources Node, or a previous userData extract, or download the official
 * pinned Node archive into userData. Never requires a preinstalled system Node.
 * Returns null on platforms we do not vendor (Linux CI) — callers fall back to Electron-as-node.
 */
export async function ensureManagedNode(): Promise<ManagedNodeCommand | null> {
  const existing = resolveManagedNode()
  if (existing) return existing
  const key = managedNodePlatformKey()
  if (!key) return null
  const spec = MANAGED_NODE_ASSETS[key]
  const dest = userDataManagedNodeRoot()
  const cacheDir = join(app.getPath('userData'), 'managed-node', '.cache')
  mkdirSync(cacheDir, { recursive: true })
  const archivePath = join(cacheDir, spec.file)
  const url = managedNodeDistUrl(spec.file)
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`managed Node download failed (${url}): HTTP ${res.status}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  verifySha256(buf, spec.sha256)
  writeFileSync(archivePath, buf)
  await installManagedNodeFromArchive(archivePath, dest)
  const resolved = resolveManagedNode()
  if (!resolved) {
    throw new Error('managed Node extract did not produce a node binary')
  }
  return resolved
}
