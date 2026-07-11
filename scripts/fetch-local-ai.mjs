import { createWriteStream, promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL, fileURLToPath } from 'node:url'
import {
  cachePathForAsset,
  catalogDownloadPlan,
  hashFile,
  loadCatalog
} from './local-ai-manifest.mjs'

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

function fail(message) {
  throw new Error(`fetch-local-ai: ${message}`)
}

async function lstatMaybe(file) {
  try {
    return await fs.lstat(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function buildResolveUrl(source) {
  const encodedPath = source.path.split('/').map(encodeURIComponent).join('/')
  return `https://huggingface.co/${source.repo}/resolve/${source.commit}/${encodedPath}`
}

async function requireRealDirectory(directory, label) {
  const stats = await fs.lstat(directory)
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail(`${label} must be a real directory`)
}

async function fetchFollowingRedirects({ url, headers, fetchImpl, maxRedirects }) {
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) {
    fail('maxRedirects must be an integer from 0 to 10')
  }
  let currentUrl = new URL(url)
  let redirects = 0
  for (;;) {
    if (currentUrl.protocol !== 'https:' || currentUrl.username || currentUrl.password) {
      fail('refusing to request a non-HTTPS or credential-bearing URL')
    }
    const response = await fetchImpl(currentUrl.href, { headers, redirect: 'manual' })
    if (!REDIRECT_STATUSES.has(response.status)) return response
    if (redirects >= maxRedirects) fail('maximum redirect count exceeded')
    const location = response.headers.get('location')
    if (!location) fail('redirect response is missing Location')
    const nextUrl = new URL(location, currentUrl)
    if (nextUrl.protocol !== 'https:' || nextUrl.username || nextUrl.password) {
      fail('refusing an unsafe redirect location')
    }
    await response.body?.cancel()
    currentUrl = nextUrl
    redirects++
  }
}

export async function downloadAsset({
  asset,
  cacheRoot,
  fetchImpl = globalThis.fetch,
  maxRedirects = 5
}) {
  if (typeof fetchImpl !== 'function') fail('fetch implementation is unavailable')

  const root = resolve(cacheRoot)
  const finalFile = cachePathForAsset(root, asset)
  const partFile = `${finalFile}.part`
  await fs.mkdir(root, { recursive: true })
  await requireRealDirectory(root, 'cache root')
  await fs.mkdir(dirname(finalFile), { recursive: true })
  await requireRealDirectory(dirname(finalFile), 'asset cache directory')

  const finalStats = await lstatMaybe(finalFile)
  if (finalStats) {
    if (!finalStats.isFile() || finalStats.isSymbolicLink() || finalStats.nlink !== 1) {
      fail('final cache entry must be a non-hardlinked regular file')
    }
    if (finalStats.size === asset.source.bytes && (await hashFile(finalFile)) === asset.source.sha256) {
      return { path: finalFile, downloaded: false, resumed: false }
    }
    fail('existing final asset does not match its manifest record')
  }

  let offset = 0
  const partStats = await lstatMaybe(partFile)
  if (partStats) {
    if (!partStats.isFile() || partStats.isSymbolicLink() || partStats.nlink !== 1) {
      fail('partial download must be a non-hardlinked regular file')
    }
    if (partStats.size > asset.source.bytes) fail('partial download exceeds its manifest size')
    offset = partStats.size
  }

  if (offset === asset.source.bytes) {
    if ((await hashFile(partFile)) === asset.source.sha256) {
      await fs.rename(partFile, finalFile)
      return { path: finalFile, downloaded: false, resumed: true }
    }
    await fs.rm(partFile, { force: true })
    fail('complete partial does not match its manifest hash')
  }

  const headers = new Headers()
  if (offset > 0) headers.set('range', `bytes=${offset}-${asset.source.bytes - 1}`)
  const response = await fetchFollowingRedirects({
    url: buildResolveUrl(asset.source),
    headers,
    fetchImpl,
    maxRedirects
  })

  let flags = 'w'
  let writeOffset = 0
  if (offset > 0 && response.status === 206) {
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '')
    if (
      !match ||
      Number(match[1]) !== offset ||
      Number(match[2]) !== asset.source.bytes - 1 ||
      Number(match[3]) !== asset.source.bytes
    ) {
      fail('server returned an unexpected Content-Range')
    }
    flags = 'a'
    writeOffset = offset
  } else if (response.status !== 200) {
    fail(`unexpected response status ${response.status}`)
  }
  if (!response.body) fail('download response has no body')

  const remaining = asset.source.bytes - writeOffset
  let received = 0
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length
      callback(received <= remaining ? null : new Error('download exceeded its manifest size'), chunk)
    }
  })
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      limiter,
      createWriteStream(partFile, { flags })
    )
  } catch (error) {
    if (received > remaining) await fs.rm(partFile, { force: true })
    throw error
  }

  const downloadedStats = await fs.lstat(partFile)
  if (
    !downloadedStats.isFile() ||
    downloadedStats.isSymbolicLink() ||
    downloadedStats.nlink !== 1 ||
    downloadedStats.size > asset.source.bytes
  ) {
    await fs.rm(partFile, { force: true })
    fail('downloaded file does not match its manifest size')
  }
  if (downloadedStats.size < asset.source.bytes) {
    fail('download ended before reaching its manifest size')
  }
  if ((await hashFile(partFile)) !== asset.source.sha256) {
    await fs.rm(partFile, { force: true })
    fail('downloaded file does not match its manifest hash')
  }
  await fs.rename(partFile, finalFile)
  return { path: finalFile, downloaded: true, resumed: writeOffset > 0 }
}

export async function fetchLocalAi({
  catalog,
  cacheRoot,
  allCandidates = false,
  fetchImpl = globalThis.fetch,
  maxRedirects = 5
}) {
  const results = []
  for (const asset of catalogDownloadPlan(catalog, { allCandidates })) {
    results.push(await downloadAsset({ asset, cacheRoot, fetchImpl, maxRedirects }))
  }
  return results
}

export async function runFetchLocalAiCli(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log('Usage: npm run fetch:local-ai -- [--all-candidates]')
    return
  }
  const unknown = args.filter((arg) => arg !== '--all-candidates')
  if (unknown.length) fail(`unknown argument "${unknown[0]}"`)

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const { catalog } = loadCatalog(join(repoRoot, 'resources/local-ai/candidates.json'))
  const results = await fetchLocalAi({
    catalog,
    cacheRoot: join(repoRoot, 'resources/local-ai/cache'),
    allCandidates: args.includes('--all-candidates')
  })
  console.log(`[fetch:local-ai] verified ${results.length} immutable model assets`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runFetchLocalAiCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
