import { lstat, rm } from 'node:fs/promises'
import { join } from 'node:path'

/** Electron Builder drops these exact tracked zero-byte directory placeholders from extraResources. */
const LEAN_PACKAGE_DIRECTORY_PLACEHOLDERS = Object.freeze([
  'cloudflare-embed',
  'operator',
  'license-lease',
  'managed-node/darwin-arm64',
  'managed-node/darwin-x64',
  'managed-node/win-x64',
  'vcredist'
])

export async function removeKnownLeanPackagePlaceholders(resourcesRoot) {
  let removed = false
  for (const directory of LEAN_PACKAGE_DIRECTORY_PLACEHOLDERS) {
    const placeholder = join(resourcesRoot, directory, '.gitkeep')
    let stat
    try {
      stat = await lstat(placeholder)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    if (!stat.isFile() || stat.size !== 0) {
      throw new Error(`Lean package ${directory} placeholder must be a zero-byte regular file`)
    }
    await rm(placeholder)
    removed = true
  }
  return removed
}
