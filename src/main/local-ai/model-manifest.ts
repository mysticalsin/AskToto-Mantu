import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import { isAbsolute, relative } from 'node:path'
import {
  localAiRoot,
  resolveLocalAiResource,
  type LocalAiPathContext
} from './resource-path'

interface ResolveSelectedTextModelOptions {
  context: LocalAiPathContext
  targetPlatform: 'darwin-arm64' | 'win32-x64'
}

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return hash.digest('hex')
}

export async function resolveSelectedTextModel({
  context,
  targetPlatform
}: ResolveSelectedTextModelOptions): Promise<{
  id: string
  sha256: string
  absolutePath: string
}> {
  const root = localAiRoot(context)
  const rootStats = await fs.lstat(root)
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error('Local AI root must be a real directory.')
  }

  const manifestPath = resolveLocalAiResource(context, 'manifest.json')
  const manifestStats = await fs.lstat(manifestPath)
  if (
    !manifestStats.isFile() ||
    manifestStats.isSymbolicLink() ||
    manifestStats.nlink !== 1 ||
    manifestStats.size <= 0 ||
    manifestStats.size > 8 * 1024 * 1024
  ) {
    throw new Error('Local AI manifest must be a bounded regular file.')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  } catch {
    throw new Error('Local AI manifest is invalid JSON.')
  }
  if (!record(parsed) || parsed.schemaVersion !== 1) {
    throw new Error('Local AI manifest schema is invalid.')
  }
  if (parsed.targetPlatform !== targetPlatform) {
    throw new Error('Local AI manifest platform does not match this executable.')
  }
  if (!record(parsed.selected) || !record(parsed.selected.text)) {
    throw new Error('Local AI manifest text selection is missing.')
  }
  const selected = parsed.selected.text
  if (
    typeof selected.id !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(selected.id) ||
    selected.runtime !== 'node-llama-cpp'
  ) {
    throw new Error('Local AI manifest text runtime is invalid.')
  }
  if (!Array.isArray(parsed.assets)) throw new Error('Local AI manifest assets are invalid.')
  const weights = parsed.assets.filter(
    (asset): asset is Record<string, unknown> =>
      record(asset) && asset.variantId === selected.id && asset.component === 'weights'
  )
  if (weights.length !== 1) {
    throw new Error('Local AI manifest must contain one selected text weight asset.')
  }

  const asset = weights[0]
  if (
    typeof asset.destination !== 'string' ||
    !asset.destination.toLowerCase().endsWith('.gguf') ||
    !Number.isSafeInteger(asset.bytes) ||
    Number(asset.bytes) <= 0 ||
    typeof asset.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(asset.sha256)
  ) {
    throw new Error('Selected text weight record is invalid.')
  }

  const candidate = resolveLocalAiResource(context, asset.destination)
  const stats = await fs.lstat(candidate)
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error('Selected text model must be a regular file.')
  }
  if (stats.nlink !== 1) throw new Error('Selected text model must not be hardlinked.')
  if (stats.size !== asset.bytes) throw new Error('Selected text model size does not match.')

  const realRoot = await fs.realpath(root)
  const realFile = await fs.realpath(candidate)
  const contained = relative(realRoot, realFile)
  if (!contained || contained.startsWith('..') || isAbsolute(contained)) {
    throw new Error('Selected text model escapes its packaged root.')
  }
  if ((await sha256(realFile)) !== asset.sha256) {
    throw new Error('Selected text model hash does not match.')
  }
  return { id: selected.id, sha256: asset.sha256, absolutePath: realFile }
}
