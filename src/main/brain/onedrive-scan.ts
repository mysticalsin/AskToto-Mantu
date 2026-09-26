/**
 * Filesystem OneDrive / second-brain scan for Mantu Intelligence.
 * Ranking and markers live in @shared/mantu-intelligence so tests do not need Electron.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import {
  type BrainScanHit,
  type BrainScanResult,
  brainHitLabel,
  collectMarkerHits,
  isMantuGroupRoot,
  listOneDriveRoots,
  nameLooksLikeBrain,
  preferredBrainPaths,
  rankBrainHits,
  scoreBrainCandidate
} from '@shared/mantu-intelligence'

export interface ScanFs {
  existsSync(path: string): boolean
  readdirSync(path: string): string[]
  isDirectory(path: string): boolean
}

const defaultFs: ScanFs = {
  existsSync,
  readdirSync: (path) => {
    try {
      return readdirSync(path)
    } catch {
      return []
    }
  },
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  }
}

export function scanOneDriveBrains(input: {
  platform?: string
  homedir?: string
  env?: Record<string, string | undefined>
  configuredFolder?: string
  fs?: ScanFs
}): BrainScanResult {
  const platform = input.platform ?? process.platform
  const home = input.homedir ?? homedir()
  const env = input.env ?? process.env
  const fs = input.fs ?? defaultFs
  const configured = (input.configuredFolder ?? '').trim()

  let cloudStorageNames: string[] | undefined
  if (platform === 'darwin') {
    const cloud = join(home, 'Library', 'CloudStorage')
    if (fs.existsSync(cloud) && fs.isDirectory(cloud)) {
      cloudStorageNames = fs.readdirSync(cloud)
    } else {
      cloudStorageNames = []
    }
  }

  const roots = listOneDriveRoots({ platform, homedir: home, env, cloudStorageNames }).filter(
    (root) => fs.existsSync(root) && fs.isDirectory(root)
  )

  const byPath = new Map<string, BrainScanHit>()
  const consider = (path: string, connected = false): void => {
    if (!path || !fs.existsSync(path) || !fs.isDirectory(path)) return
    if (byPath.has(path)) {
      if (connected) byPath.get(path)!.connected = true
      return
    }
    const names = safeList(fs, path)
    const markers = collectMarkerHits(names)
    const folderName = basename(path)
    const preferred =
      /^ai second brain$/i.test(folderName) && (isMantuGroupRoot(path) || markers.length > 0 || nameLooksLikeBrain(folderName))
    const looksLike = preferred || nameLooksLikeBrain(folderName) || markers.length > 0
    if (!looksLike && !connected) return
    const hit: BrainScanHit = {
      path,
      label: brainHitLabel(path),
      markers,
      preferred: /^ai second brain$/i.test(folderName),
      score: scoreBrainCandidate({ path, folderName, markers, connected }),
      connected
    }
    byPath.set(path, hit)
  }

  for (const path of preferredBrainPaths(roots)) consider(path)
  for (const root of roots) {
    consider(join(root, 'Documents', 'AI Second Brain'))
    consider(join(root, 'AI Second Brain'))
    probeChildren(fs, join(root, 'Documents'), consider)
    probeChildren(fs, root, consider)
  }

  if (configured) consider(configured, true)

  return {
    hits: rankBrainHits([...byPath.values()]),
    connectedPath: configured,
    scannedRoots: roots
  }
}

function probeChildren(fs: ScanFs, dir: string, consider: (path: string) => void): void {
  if (!fs.existsSync(dir) || !fs.isDirectory(dir)) return
  for (const name of safeList(fs, dir)) {
    if (name.startsWith('.') && name !== '.brain' && name !== '.obsidian') continue
    consider(join(dir, name))
  }
}

function safeList(fs: ScanFs, path: string): string[] {
  try {
    return fs.readdirSync(path)
  } catch {
    return []
  }
}
