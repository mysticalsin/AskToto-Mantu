import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  buildRuntimeManifest,
  loadCatalog,
  resolveCatalogSelection,
  validateCatalog,
  verifyPayload,
  verifySelectedCache,
  verifyTrackedRecords
} from './local-ai-manifest.mjs'

export async function checkLocalAi({
  catalog,
  catalogSha256,
  repoRoot,
  cacheRoot,
  payloadRoot,
  selection,
  platform,
  requireRelease = false
}) {
  validateCatalog(catalog)
  await verifyTrackedRecords({ catalog, repoRoot })
  if (payloadRoot !== undefined) {
    const manifest = await verifyPayload({
      catalog,
      catalogSha256,
      payloadRoot,
      platform,
      requireRelease
    })
    return { ready: true, manifest }
  }

  const resolvedSelection = resolveCatalogSelection(catalog, selection)
  const manifest = buildRuntimeManifest({ catalog, catalogSha256, selection: resolvedSelection, platform })
  if (requireRelease && manifest.approval !== 'release') {
    throw new Error('check-local-ai: release approval is required')
  }
  try {
    await verifySelectedCache({
      catalog,
      cacheRoot,
      selection: resolvedSelection,
      platform
    })
  } catch (error) {
    return {
      ready: false,
      error: error instanceof Error ? error.message : String(error),
      hint: 'Run npm run fetch:local-ai to provision the selected immutable model assets.'
    }
  }

  return { ready: true, manifest }
}

function parseCheckArgs(args) {
  const options = { requireRelease: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--help') return { help: true }
    if (arg === '--require-release') {
      options.requireRelease = true
      continue
    }
    if (arg === '--platform') {
      const value = args[++index]
      if (!value || value.startsWith('--')) throw new Error('check-local-ai: --platform needs a value')
      if (options.platform) throw new Error('check-local-ai: --platform may be provided only once')
      options.platform = value
      continue
    }
    throw new Error(`check-local-ai: unknown argument "${arg}"`)
  }
  return options
}

export async function runCheckLocalAiCli(args = process.argv.slice(2)) {
  const options = parseCheckArgs(args)
  if (options.help) {
    console.log(
      'Usage: npm run check:local-ai -- --platform <darwin-arm64|win32-x64> [--require-release]'
    )
    return
  }
  if (!options.platform) throw new Error('check-local-ai: --platform is required')
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const { catalog, catalogSha256 } = loadCatalog(join(repoRoot, 'resources/local-ai/candidates.json'))
  const result = await checkLocalAi({
    catalog,
    catalogSha256,
    repoRoot,
    cacheRoot: join(repoRoot, 'resources/local-ai/cache'),
    payloadRoot: join(repoRoot, 'resources/local-ai/payload'),
    platform: options.platform,
    requireRelease: options.requireRelease
  })
  console.log(
    `[check:local-ai] verified ${result.manifest.selected.text.id} + ${result.manifest.selected.vision.id} for ${result.manifest.targetPlatform}`
  )
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCheckLocalAiCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
