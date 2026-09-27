#!/usr/bin/env node
// scripts/publish-release.mjs — publish one verified platform lane to the shared Metis-Releases feed.
// Node builtins plus existing release gates only.
//
// State machine: a platform with no feed release creates a draft, uploads exactly its own verified
// bundle, verifies GitHub's sha256 digests, then publishes and pins Latest. A second platform joins
// the public release by uploading installers first, verifying their digests, and uploading update
// metadata last so clients never see metadata for bytes GitHub has not proven.
//
// Functions named *Problems return string[]; empty means OK. Mutating functions throw one Error whose
// message lists every problem.
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { sha256File, uploadProblems } from './qa/provenance.mjs'
import { verifyUpdateMetadata } from './check-update-metadata.mjs'

export const PLATFORMS = Object.freeze({
  mac: Object.freeze({
    label: 'macOS',
    other: 'win',
    metadata: 'latest-mac.yml',
    artifacts: (version) => [
      `Metis-${version}.dmg`,
      `Metis-${version}.dmg.blockmap`,
      `Metis-${version}.zip`,
      `Metis-${version}.zip.blockmap`,
      'latest-mac.yml'
    ]
  }),
  win: Object.freeze({
    label: 'Windows',
    other: 'mac',
    metadata: 'latest.yml',
    artifacts: (version) => [
      `Metis-Setup-${version}.exe`,
      `Metis-Setup-${version}.exe.blockmap`,
      `Metis-Portable-${version}.exe`,
      'latest.yml'
    ]
  })
})

export const RELEASE_NOTES =
  'Signed Métis desktop installers. A platform appears here only once its own release gates pass: macOS builds are Developer ID-signed and notarized, Windows builds are Authenticode-signed.'

export function platformAssets(platform, version) {
  const config = PLATFORMS[platform]
  if (!config) throw new Error(`unknown platform: ${platform}`)
  return config.artifacts(version)
}

export function bundleProblems(platform, version, names) {
  const expected = platformAssets(platform, version)
  const expectedSet = new Set(expected)
  const actualSet = new Set(names)
  const problems = []
  for (const name of expected) {
    if (!actualSet.has(name)) problems.push(`missing required ${PLATFORMS[platform].label} release asset: ${name}`)
  }
  for (const name of names) {
    if (!expectedSet.has(name)) problems.push(`unexpected ${PLATFORMS[platform].label} release asset: ${name}`)
  }
  return problems
}

function isWithinBothPlatforms(names, expectedOwn, expectedOther) {
  return names.every((name) => expectedOwn.has(name) || expectedOther.has(name))
}

export function planPublication(platform, version, releases) {
  const config = PLATFORMS[platform]
  if (!config) throw new Error(`unknown platform: ${platform}`)
  const expectedOwn = new Set(platformAssets(platform, version))
  const expectedOther = new Set(platformAssets(config.other, version))

  if (releases.some((release) => release.prerelease)) {
    throw new Error(`Refusing to publish ${config.label} ${version}: a prerelease already exists for this tag.`)
  }
  if (releases.length > 1) {
    throw new Error(`Refusing to publish ${config.label} ${version}: multiple releases exist for this tag.`)
  }
  if (releases.length === 0) return { action: 'create' }

  const release = releases[0]
  const names = release.assets.map((asset) => asset.name)
  const ownNames = names.filter((name) => expectedOwn.has(name))
  const otherNames = names.filter((name) => expectedOther.has(name))
  const foreignNames = names.filter((name) => !expectedOwn.has(name) && !expectedOther.has(name))

  if (release.draft) {
    if (isWithinBothPlatforms(names, expectedOwn, expectedOther)) {
      return { action: 'replace-draft', release }
    }
    throw new Error(
      `Refusing to publish ${config.label} ${version}: a draft release already exists but is not this platform's leftover draft. Delete or inspect the draft before retrying.`
    )
  }

  if (ownNames.length > 0) {
    if (ownNames.length === expectedOwn.size) return { action: 'complete', release }
    throw new Error(
      `Refusing to publish ${config.label} ${version}: the public release already has ${ownNames.join(', ')} but not ${config.metadata}; if a previous upload was interrupted, delete those assets before retrying.`
    )
  }
  if (foreignNames.length > 0) {
    throw new Error(
      `Refusing to publish ${config.label} ${version}: the public release contains unexpected assets: ${foreignNames.join(', ')}.`
    )
  }
  if (otherNames.length !== expectedOther.size) {
    throw new Error(
      `Refusing to publish ${config.label} ${version}: the public release is not a complete ${PLATFORMS[config.other].label} release.`
    )
  }
  return { action: 'join', release }
}

export function feedRepository(source) {
  const owner = source.match(/^\s*owner:\s*(\S+)\s*$/m)?.[1]
  const repo = source.match(/^\s*repo:\s*(\S+)\s*$/m)?.[1]
  const provider = source.match(/^\s*provider:\s*(\S+)\s*$/m)?.[1]
  const problems = []
  if (provider !== 'github') problems.push('electron-builder.yml publish.provider must be github')
  if (!owner) problems.push('electron-builder.yml publish.owner is missing')
  if (!repo) problems.push('electron-builder.yml publish.repo is missing')
  if (problems.length) throw new Error(problems.join('\n'))
  return `${owner}/${repo}`
}

export function toRelease(value) {
  return {
    id: value.id,
    tag: value.tag_name,
    draft: value.draft,
    prerelease: value.prerelease,
    assets: (value.assets ?? []).map((asset) => ({
      name: asset.name,
      state: asset.state,
      size: asset.size,
      digest: asset.digest
    }))
  }
}

function runGh(args, options = {}) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    env: { ...process.env, GH_TOKEN: options.token ?? process.env.GH_TOKEN },
    stdio: options.stdio ?? 'pipe',
    maxBuffer: 64 * 1024 * 1024
  })
  if (result.error) throw result.error
  if (result.status === 0) return result.stdout
  const output = `${result.stderr || ''}\n${result.stdout || ''}`.trim()
  throw new Error(output || `gh exited with status ${result.status}`)
}

export function ghFeed({ repo, token }) {
  const api = {
    releasesTagged(tag) {
      const pages = JSON.parse(runGh(['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`], { token }))
      const releases = pages.flat()
      return releases.filter((release) => release.tag_name === tag).map(toRelease)
    },
    release(id) {
      return toRelease(JSON.parse(runGh(['api', `repos/${repo}/releases/${id}`], { token })))
    },
    createDraft(tag) {
      runGh(
        [
          'release',
          'create',
          tag,
          '--repo',
          repo,
          '--draft',
          '--title',
          `Métis ${tag}`,
          '--notes',
          RELEASE_NOTES
        ],
        { token }
      )
      const release = api.releasesTagged(tag).find((candidate) => candidate.draft)
      if (!release) throw new Error(`created draft ${tag} on ${repo}, but could not read it back`)
      return release
    },
    upload(tag, paths) {
      runGh(['release', 'upload', tag, ...paths, '--repo', repo], { token })
    },
    publish(id) {
      runGh(['api', `repos/${repo}/releases/${id}`, '--method', 'PATCH', '-F', 'draft=false', '-F', 'prerelease=false', '-f', 'make_latest=true'], { token })
    },
    deleteDraft(id) {
      runGh(['api', `repos/${repo}/releases/${id}`, '--method', 'DELETE'], { token })
    },
    latestTag() {
      const json = runGh(['api', `repos/${repo}/releases/latest`, '--jq', '.tag_name'], { token })
      return json.trim()
    }
  }
  return api
}

async function readBundle(platform, version, bundleDir) {
  const absoluteDir = resolve(bundleDir)
  const names = existsSync(absoluteDir)
    ? readdirSync(absoluteDir).filter((name) => lstatSync(join(absoluteDir, name)).isFile()).sort()
    : []
  const problems = bundleProblems(platform, version, names)
  if (problems.length) throw new Error(problems.join('\n'))

  await verifyUpdateMetadata(join(absoluteDir, PLATFORMS[platform].metadata), version)

  const manifest = []
  for (const name of platformAssets(platform, version)) {
    const path = join(absoluteDir, name)
    const { size } = statSync(path)
    manifest.push({ name, path, size, sha256: await sha256File(path) })
  }
  return { dir: absoluteDir, manifest }
}

function uploadedSubset(release, manifest) {
  const names = new Set(manifest.map((asset) => asset.name))
  return release.assets.filter((asset) => names.has(asset.name))
}

function digestProblems(release, manifest) {
  return uploadProblems(
    manifest.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
    uploadedSubset(release, manifest)
  )
}

function createRelease({ tag, feed, bundle, repo = '<the feed>' }) {
  let draft = feed.createDraft(tag)
  feed.upload(tag, bundle.manifest.map((asset) => asset.path))
  draft = feed.release(draft.id)
  const problems = digestProblems(draft, bundle.manifest)
  if (problems.length) throw new Error(problems.join('\n'))
  feed.publish(draft.id)
  const latest = feed.latestTag()
  if (latest !== tag) {
    throw new Error(`${tag} is public but not Latest; set it with \`gh release edit ${tag} --latest --repo ${repo}\`.`)
  }
  return { action: 'create', release: feed.release(draft.id) }
}

function joinRelease({ platform, tag, feed, release, bundle }) {
  const metadata = PLATFORMS[platform].metadata
  const installers = bundle.manifest.filter((asset) => asset.name !== metadata)
  const metadataAsset = bundle.manifest.find((asset) => asset.name === metadata)
  feed.upload(tag, installers.map((asset) => asset.path))
  let refreshed = feed.release(release.id)
  const problems = digestProblems(refreshed, installers)
  if (problems.length) throw new Error(problems.join('\n'))
  feed.upload(tag, [metadataAsset.path])
  refreshed = feed.release(release.id)
  const finalProblems = digestProblems(refreshed, bundle.manifest)
  if (finalProblems.length) throw new Error(finalProblems.join('\n'))
  return { action: 'join', release: refreshed }
}

export async function publishPlatform({ platform, tag, bundleDir, feed, repo = '<the feed>' }) {
  if (!Object.hasOwn(PLATFORMS, platform)) throw new Error(`unknown platform: ${platform}`)
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`release tag must be a plain vX.Y.Z tag: ${tag}`)
  const version = tag.slice(1)
  const bundle = await readBundle(platform, version, bundleDir)
  const releases = feed.releasesTagged(tag)
  const plan = planPublication(platform, version, releases)
  if (plan.action === 'complete') return { action: 'complete', release: plan.release }
  if (plan.action === 'replace-draft') {
    const expectedOwn = new Set(platformAssets(platform, version))
    const expectedOther = new Set(platformAssets(PLATFORMS[platform].other, version))
    const fresh = feed.release(plan.release.id)
    const names = fresh.assets.map((asset) => asset.name)
    if (!fresh.draft || !isWithinBothPlatforms(names, expectedOwn, expectedOther)) {
      throw new Error(`Refusing to replace ${PLATFORMS[platform].label} ${version}: the release is no longer a replaceable leftover draft.`)
    }
    feed.deleteDraft(plan.release.id)
    return createRelease({ tag, feed, bundle, repo })
  }
  if (plan.action === 'create') return createRelease({ tag, feed, bundle, repo })
  return joinRelease({ platform, tag, feed, release: plan.release, bundle })
}

async function main() {
  const [platform, bundleDir] = process.argv.slice(2)
  if (!Object.hasOwn(PLATFORMS, platform) || !bundleDir) {
    throw new Error('usage: node scripts/publish-release.mjs <mac|win> <bundle-dir>')
  }
  const tag = process.env.GITHUB_REF_NAME
  if (!tag) throw new Error('GITHUB_REF_NAME is not set')
  const token = process.env.GH_TOKEN
  if (!token) throw new Error('GH_TOKEN is not set')
  const repo = feedRepository(readFileSync(resolve('electron-builder.yml'), 'utf8'))
  const result = await publishPlatform({ platform, tag, bundleDir, feed: ghFeed({ repo, token }), repo })
  const message =
    result.action === 'create'
      ? `${PLATFORMS[platform].label} ${tag} published to ${repo} as a new Latest release.`
      : result.action === 'complete'
        ? `${PLATFORMS[platform].label} ${tag} is already published on ${repo}; nothing to do.`
      : `${PLATFORMS[platform].label} ${tag} joined the public release on ${repo}.`
  console.log(message)
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
