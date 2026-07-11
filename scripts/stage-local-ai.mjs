import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  buildRuntimeManifest,
  cachePathForAsset,
  loadCatalog,
  resolveCatalogSelection,
  serializeRuntimeManifest,
  validateCatalog,
  verifyPayload,
  verifySelectedCache,
  verifyTrackedRecords
} from './local-ai-manifest.mjs'

async function exists(path) {
  try {
    await fs.lstat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

export async function stageLocalAi({
  repoRoot,
  cacheRoot,
  payloadRoot,
  catalog,
  catalogSha256,
  selection,
  platform
}) {
  validateCatalog(catalog)
  await verifyTrackedRecords({ catalog, repoRoot })
  await verifySelectedCache({ catalog, cacheRoot, selection, platform })
  const manifest = buildRuntimeManifest({ catalog, catalogSha256, selection, platform })

  const target = resolve(payloadRoot)
  const parent = dirname(target)
  const name = basename(target)
  const nonce = randomBytes(8).toString('hex')
  const staging = join(parent, `.${name}.staging-${nonce}`)
  const rollback = join(parent, `.${name}.rollback-${nonce}`)
  await fs.mkdir(parent, { recursive: true })
  await fs.rm(staging, { recursive: true, force: true })
  await fs.rm(rollback, { recursive: true, force: true })
  await fs.mkdir(staging, { recursive: true })

  try {
    const assetById = new Map(catalog.assets.map((asset) => [asset.id, asset]))
    const licenseById = new Map(catalog.licenses.map((record) => [record.id, record]))
    const noticeById = new Map(catalog.notices.map((record) => [record.id, record]))
    const copy = async (source, destination) => {
      await fs.mkdir(dirname(destination), { recursive: true })
      await fs.copyFile(source, destination)
    }

    for (const record of manifest.assets) {
      const asset = assetById.get(record.id)
      await copy(cachePathForAsset(cacheRoot, asset), join(staging, record.destination))
    }
    for (const record of manifest.licenses) {
      const source = join(resolve(repoRoot), licenseById.get(record.id).path)
      await copy(source, join(staging, record.destination))
    }
    for (const record of manifest.notices) {
      const source = join(resolve(repoRoot), noticeById.get(record.id).path)
      await copy(source, join(staging, record.destination))
    }
    await fs.writeFile(join(staging, 'manifest.json'), serializeRuntimeManifest(manifest), 'utf8')
    await verifyPayload({ catalog, catalogSha256, payloadRoot: staging, platform })

    const hadTarget = await exists(target)
    if (hadTarget) await fs.rename(target, rollback)
    try {
      await fs.rename(staging, target)
    } catch (error) {
      if (hadTarget) await fs.rename(rollback, target)
      throw error
    }
    if (hadTarget) await fs.rm(rollback, { recursive: true, force: true }).catch(() => {})
    return manifest
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

export function parseStageArgs(args) {
  const options = { evaluation: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--help') return { help: true }
    if (arg === '--evaluation') {
      options.evaluation = true
      continue
    }
    if (['--platform', '--text-variant', '--vision-variant'].includes(arg)) {
      const value = args[++index]
      if (!value || value.startsWith('--')) throw new Error(`stage-local-ai: ${arg} needs a value`)
      const key = arg === '--platform' ? 'platform' : arg === '--text-variant' ? 'textVariant' : 'visionVariant'
      if (options[key]) throw new Error(`stage-local-ai: ${arg} may be provided only once`)
      options[key] = value
      continue
    }
    throw new Error(`stage-local-ai: unknown argument "${arg}"`)
  }
  if (options.evaluation && !(options.textVariant && options.visionVariant)) {
    throw new Error('stage-local-ai: --evaluation requires both variant IDs')
  }
  if (!options.evaluation && (options.textVariant || options.visionVariant)) {
    throw new Error('stage-local-ai: variant overrides require --evaluation and both variant IDs')
  }
  return options
}

export async function runStageLocalAiCli(args = process.argv.slice(2)) {
  const options = parseStageArgs(args)
  if (options.help) {
    console.log(
      'Usage: npm run stage:local-ai -- --platform <darwin-arm64|win32-x64> [--evaluation --text-variant <id> --vision-variant <id>]'
    )
    return
  }
  if (!options.platform) throw new Error('stage-local-ai: --platform is required')

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const { catalog, catalogSha256 } = loadCatalog(join(repoRoot, 'resources/local-ai/candidates.json'))
  const selection = options.evaluation
    ? {
        textVariant: options.textVariant,
        visionVariant: options.visionVariant,
        approval: 'evaluation'
      }
    : resolveCatalogSelection(catalog)
  const manifest = await stageLocalAi({
    repoRoot,
    cacheRoot: join(repoRoot, 'resources/local-ai/cache'),
    payloadRoot: join(repoRoot, 'resources/local-ai/payload'),
    catalog,
    catalogSha256,
    selection,
    platform: options.platform
  })
  console.log(
    `[stage:local-ai] staged ${manifest.selected.text.id} + ${manifest.selected.vision.id} for ${manifest.targetPlatform}`
  )
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runStageLocalAiCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
