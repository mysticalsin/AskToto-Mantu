import { lstat, rm } from 'node:fs/promises'
import { join } from 'node:path'

/** Electron Builder drops this tracked zero-byte directory placeholder from extraResources. */
export async function removeCloudflareEmbedPlaceholder(resourcesRoot) {
  const placeholder = join(resourcesRoot, 'cloudflare-embed', '.gitkeep')
  let stat
  try {
    stat = await lstat(placeholder)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  if (!stat.isFile() || stat.size !== 0) {
    throw new Error('Lean package cloudflare-embed placeholder must be a zero-byte regular file')
  }
  await rm(placeholder)
  return true
}
