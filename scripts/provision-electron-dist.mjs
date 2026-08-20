#!/usr/bin/env node
/**
 * provision-electron-dist.mjs — stage the official Electron zips for a mac build into
 * resources/electron-dist/, verified against Electron's own published SHASUMS256.txt.
 *
 * WHY THIS EXISTS
 * electron-builder 26.15.3 bundles its own copy of @electron/get (3.1.0) whose checksum-validation
 * path fails for any mac arch it has to fetch fresh: it reports
 *     No checksum found in checksum file for "electron-v<version>-darwin-x64.zip"
 * even though the published SHASUMS256.txt plainly contains that entry, the downloaded zip matches
 * it, and the very same library validates the very same file correctly when called directly outside
 * the electron-builder CLI. It fails identically on a cache hit and on a fresh download, under both
 * ReadWrite and ReadOnly ELECTRON_DOWNLOAD_CACHE_MODE, for `--x64` alone as well as `--universal`.
 * It is a defect in that dependency, not in this project's configuration.
 *
 * Rather than set electronDownload.isVerifyChecksum=false — which would silently disable integrity
 * checking for every Electron download forever — this script takes over the download and does the
 * verification itself, explicitly and visibly: fetch the official SHASUMS256.txt, fetch each zip,
 * and refuse to stage anything whose sha256 does not match. electron-builder is then pointed at the
 * result with `-c.electronDist=resources/electron-dist`, which makes it skip its own downloader
 * (see app-builder-lib ElectronFramework.unpack → selectElectron: a DIRECTORY containing
 * `electron-v${version}-${platformName}-${arch}.zip` is extracted directly). One directory serves
 * every mac target because that filename is resolved per platformName AND per arch: both arches of a
 * universal build, and the separate `mas` archive the Mac App Store target asks for
 * (app-builder-lib macPackager.getPlatformConfig sets platformName='mas' for it). Staging the darwin
 * zip for a mas build would NOT fail loudly — selectElectron would not find the name it wants and
 * would fall through to its "custom already-unpacked distribution" branch, copying the directory
 * verbatim into a broken .app — so the platform is explicit here rather than inferred.
 *
 * Scoped to the mac chains on purpose — it is wired via the CLI flag in package.json's mac scripts,
 * NOT as a top-level `electronDist` in electron-builder.yml, because a Windows build would then look
 * for a win32 zip in the same directory, not find one, and fall through to the "already-unpacked
 * distribution" branch with a directory that is nothing of the sort.
 *
 * Idempotent: a staged zip whose sha256 already matches is left alone and re-verified, never
 * re-downloaded. Re-run cost after the first build is one small SHASUMS fetch.
 *
 * Usage: node scripts/provision-electron-dist.mjs [--platform=darwin|mas] [arch...]
 *        (defaults: --platform=darwin, arches arm64 x64)
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { get as httpsGet } from 'node:https'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(REPO_ROOT, 'resources', 'electron-dist')
const REQUEST_TIMEOUT_MS = 60_000

const argv = process.argv.slice(2)
const arches = argv.filter((a) => !a.startsWith('-'))
const ARCHES = arches.length ? arches : ['arm64', 'x64']

// Only the two mac platformNames electron-builder can ask this project for. Reject anything else here,
// before a single byte is fetched: an unrecognised name would resolve to an archive that does not
// exist, and the failure would surface as a confusing SHASUMS miss halfway through a build.
const PLATFORMS = ['darwin', 'mas']
const platformFlag = argv.find((a) => a.startsWith('--platform='))
const PLATFORM = platformFlag ? platformFlag.slice('--platform='.length) : 'darwin'
if (!PLATFORMS.includes(PLATFORM)) {
  console.error(
    `provision-electron-dist: unknown --platform "${PLATFORM}" — expected one of: ${PLATFORMS.join(', ')}`
  )
  process.exit(1)
}

/** Electron version actually installed, so this can never drift from what electron-builder packages. */
function electronVersion() {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'node_modules', 'electron', 'package.json'), 'utf8'))
  return pkg.version
}

function fetchStream(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = httpsGet(url, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        if (redirectsLeft <= 0) {
          reject(new Error(`too many redirects for ${url}`))
          return
        }
        // GitHub release assets 302 to objects.githubusercontent.com.
        fetchStream(new URL(res.headers.location, url).toString(), redirectsLeft - 1).then(resolve, reject)
        return
      }
      if (status !== 200) {
        res.resume()
        reject(new Error(`HTTP ${status} for ${url}`))
        return
      }
      resolve(res)
    })
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`request timeout for ${url}`)))
    req.on('error', reject)
  })
}

async function fetchText(url) {
  const res = await fetchStream(url)
  const chunks = []
  for await (const c of res) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

async function download(url, dest) {
  mkdirSync(dirname(dest), { recursive: true })
  const tmp = `${dest}.partial`
  rmSync(tmp, { force: true })
  const res = await fetchStream(url)
  // Download to .partial and rename only on success: an interrupted write must never be left behind
  // under the real filename, where the next run's sha256 check would be the only thing standing
  // between a truncated zip and a packaged app.
  await pipeline(res, createWriteStream(tmp))
  renameSync(tmp, dest)
}

function sha256Of(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** Parse `<sha256> *<filename>` lines into a filename -> hash map. */
function parseShasums(text) {
  const map = new Map()
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line)
    if (m) map.set(m[2], m[1].toLowerCase())
  }
  return map
}

async function main() {
  const version = electronVersion()
  const base = `https://github.com/electron/electron/releases/download/v${version}/`
  console.log(`=== provision-electron-dist: electron ${version} (${PLATFORM}) -> ./resources/electron-dist ===`)

  const shasums = parseShasums(await fetchText(`${base}SHASUMS256.txt`))
  if (shasums.size === 0) {
    throw new Error(`SHASUMS256.txt for v${version} parsed to zero entries — refusing to stage unverified zips.`)
  }

  mkdirSync(OUT_DIR, { recursive: true })
  for (const arch of ARCHES) {
    const name = `electron-v${version}-${PLATFORM}-${arch}.zip`
    const expected = shasums.get(name)
    if (!expected) {
      throw new Error(`SHASUMS256.txt for v${version} has no entry for ${name}. Refusing to stage it.`)
    }
    const dest = join(OUT_DIR, name)

    if (existsSync(dest) && statSync(dest).size > 0 && sha256Of(dest) === expected) {
      console.log(`  [ok] ${name} already staged and verified (${expected.slice(0, 12)}…)`)
      continue
    }
    console.log(`  [fetch] ${name}`)
    await download(base + name, dest)

    const actual = sha256Of(dest)
    if (actual !== expected) {
      rmSync(dest, { force: true })
      throw new Error(
        `${name} sha256 mismatch against Electron's published SHASUMS256.txt:\n` +
          `  expected ${expected}\n  actual   ${actual}\nDeleted the download; re-run to retry.`
      )
    }
    console.log(`  [ok] ${name} verified (${actual.slice(0, 12)}…)`)
  }
  console.log('=== provision-electron-dist complete ===')
}

main().catch((err) => {
  console.error('\nprovision-electron-dist FAILED:', err.message)
  process.exit(1)
})
