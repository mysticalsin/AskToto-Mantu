import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  feedRepository,
  platformAssets,
  publishPlatform,
  toRelease
} from './publish-release.mjs'

type Platform = 'mac' | 'win'

interface FeedAsset {
  name: string
  state: string
  size: number
  digest: string
}

interface FeedRelease {
  id: number
  tag: string
  draft: boolean
  prerelease: boolean
  assets: FeedAsset[]
}

const VERSION = '1.2.3'
const TAG = `v${VERSION}`
const tempRoots: string[] = []

const platformLabels: Record<Platform, string> = {
  mac: 'macOS',
  win: 'Windows'
}

const primaryInstaller: Record<Platform, string> = {
  mac: `Metis-${VERSION}.dmg`,
  win: `Metis-Setup-${VERSION}.exe`
}

const metadataName: Record<Platform, string> = {
  mac: 'latest-mac.yml',
  win: 'latest.yml'
}

function otherPlatform(platform: Platform): Platform {
  return platform === 'mac' ? 'win' : 'mac'
}

function fileBytes(name: string): Buffer {
  return Buffer.from(`${name}\nfixture-bytes-for-${VERSION}\n`, 'utf8')
}

function sha512Base64(bytes: Buffer): string {
  return createHash('sha512').update(bytes).digest('base64')
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'metis-publish-release-'))
  tempRoots.push(root)
  return root
}

function makeBundle(platform: Platform, options: { omit?: string; extra?: string; wrongMetadata?: boolean } = {}) {
  const dir = makeTempRoot()
  const names = platformAssets(platform, VERSION) as string[]
  const primary = platform === 'mac' ? `Metis-${VERSION}.zip` : `Metis-Setup-${VERSION}.exe`

  for (const name of names.filter((name) => name !== metadataName[platform] && name !== options.omit)) {
    writeFileSync(join(dir, name), fileBytes(name))
  }
  if (options.extra) writeFileSync(join(dir, options.extra), fileBytes(options.extra))

  const primaryBytes = fileBytes(primary)
  const primaryStat = statSync(join(dir, primary))
  const primarySha512 = options.wrongMetadata ? sha512Base64(Buffer.from('wrong bytes')) : sha512Base64(primaryBytes)
  const metadata = [
    `version: ${VERSION}`,
    `path: ${primary}`,
    `sha512: ${primarySha512}`,
    `releaseDate: '2026-09-27T00:00:00.000Z'`,
    'files:',
    `  - url: ${primary}`,
    `    sha512: ${primarySha512}`,
    `    size: ${primaryStat.size}`,
    ''
  ].join('\n')
  if (metadataName[platform] !== options.omit) writeFileSync(join(dir, metadataName[platform]), metadata)
  return dir
}

function assetsFor(platform: Platform, names = platformAssets(platform, VERSION) as string[]): FeedAsset[] {
  return names.map((name) => {
    const bytes = fileBytes(name)
    return { name, state: 'uploaded', size: bytes.length, digest: `sha256:${sha256Hex(bytes)}` }
  })
}

function assetsFromBundle(bundleDir: string, names: string[]): FeedAsset[] {
  return names.map((name) => {
    const path = join(bundleDir, name)
    const bytes = readFileSync(path)
    return { name, state: 'uploaded', size: statSync(path).size, digest: `sha256:${sha256Hex(bytes)}` }
  })
}

function replacementMutations(platform: Platform, deletedId: number): string[] {
  return [
    `delete ${deletedId}`,
    'create',
    ...(platformAssets(platform, VERSION) as string[]).map((name) => `upload ${name}`),
    'publish'
  ]
}

class FakeFeed {
  releases: FeedRelease[]
  latest: string | null = null
  mutations: string[] = []
  listings = 0
  corruptDigests = new Set<string>()
  staleLatestAfterPublish: string | null = null
  private nextId = 100

  constructor(releases: FeedRelease[] = []) {
    this.releases = releases
    for (const release of releases) this.nextId = Math.max(this.nextId, release.id + 1)
  }

  releasesTagged(tag: string) {
    this.listings += 1
    return this.releases.filter((release) => release.tag === tag)
  }

  release(id: number) {
    const release = this.releases.find((candidate) => candidate.id === id)
    if (!release) throw new Error(`missing release ${id}`)
    return release
  }

  createDraft(tag: string) {
    const release: FeedRelease = { id: this.nextId++, tag, draft: true, prerelease: false, assets: [] }
    this.releases.push(release)
    this.mutations.push('create')
    return release
  }

  upload(tag: string, paths: string[]) {
    const release =
      this.releases.find((candidate) => candidate.tag === tag && !candidate.draft) ??
      this.releases.find((candidate) => candidate.tag === tag && candidate.draft)
    if (!release) throw new Error(`missing release for ${tag}`)
    for (const path of paths) {
      const name = basename(path)
      if (release.assets.some((asset) => asset.name === name)) throw new Error(`${name} already exists`)
      const bytes = readFileSync(path)
      const digest = this.corruptDigests.has(name)
        ? `sha256:${sha256Hex(Buffer.from(`corrupt-${name}`))}`
        : `sha256:${sha256Hex(bytes)}`
      release.assets.push({ name, state: 'uploaded', size: statSync(path).size, digest })
      this.mutations.push(`upload ${name}`)
    }
  }

  publish(id: number) {
    const release = this.release(id)
    release.draft = false
    release.prerelease = false
    this.latest = this.staleLatestAfterPublish ?? release.tag
    this.mutations.push('publish')
  }

  deleteDraft(id: number) {
    const index = this.releases.findIndex((release) => release.id === id)
    if (index < 0) throw new Error(`missing release ${id}`)
    this.releases.splice(index, 1)
    this.mutations.push(`delete ${id}`)
  }

  latestTag() {
    return this.latest
  }
}

function release(
  overrides: Partial<FeedRelease> & { assets?: FeedAsset[]; platform?: Platform; id?: number } = {}
): FeedRelease {
  const platform = overrides.platform
  return {
    id: overrides.id ?? 1,
    tag: overrides.tag ?? TAG,
    draft: overrides.draft ?? false,
    prerelease: overrides.prerelease ?? false,
    assets: overrides.assets ?? (platform ? assetsFor(platform) : []),
  }
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('publish-release platform rules (M2-0053)', () => {
  for (const platform of ['mac', 'win'] as Platform[]) {
    it(`MQA-292: the first ${platformLabels[platform]} platform reaches the feed through a draft that becomes public and Latest only after its exact assets and digests are verified`, async () => {
      const feed = new FakeFeed()
      const bundleDir = makeBundle(platform)

      await publishPlatform({ platform, tag: TAG, bundleDir, feed })

      expect(feed.releases).toHaveLength(1)
      expect(feed.releases[0]).toMatchObject({ tag: TAG, draft: false, prerelease: false })
      expect(feed.releases[0].assets.map((asset) => asset.name)).toEqual(platformAssets(platform, VERSION))
      expect(feed.latest).toBe(TAG)
      expect(feed.mutations).toEqual([
        'create',
        ...(platformAssets(platform, VERSION) as string[]).map((name) => `upload ${name}`),
        'publish'
      ])
    })

    it(`the second ${platformLabels[platform]} platform joins the public release: installers first, update metadata last, Latest untouched`, async () => {
      const other = otherPlatform(platform)
      const feed = new FakeFeed()
      await publishPlatform({ platform: other, tag: TAG, bundleDir: makeBundle(other), feed })
      feed.latest = 'v9.9.9'
      feed.mutations = []

      await publishPlatform({ platform, tag: TAG, bundleDir: makeBundle(platform), feed })

      expect(feed.releases[0].assets.map((asset) => asset.name).sort()).toEqual(
        [...(platformAssets(other, VERSION) as string[]), ...(platformAssets(platform, VERSION) as string[])].sort()
      )
      expect(feed.mutations).not.toContain('create')
      expect(feed.mutations).not.toContain('publish')
      const metadataIndex = feed.mutations.indexOf(`upload ${metadataName[platform]}`)
      expect(metadataIndex).toBeGreaterThan(0)
      for (const name of (platformAssets(platform, VERSION) as string[]).filter((name) => name !== metadataName[platform])) {
        expect(feed.mutations.indexOf(`upload ${name}`)).toBeLessThan(metadataIndex)
      }
      expect(feed.latest).toBe('v9.9.9')
    })

    it(`refuses an owner-channel prerelease of the same version and leaves it untouched for ${platformLabels[platform]}`, async () => {
      const feed = new FakeFeed([
        release({
          prerelease: true,
          assets: [
            assetsFor('mac', [`Metis-${VERSION}.dmg`])[0],
            assetsFor('mac', ['SHA256SUMS.txt'])[0],
            assetsFor('mac', ['provenance.json'])[0]
          ]
        })
      ])

      await expect(publishPlatform({ platform, tag: TAG, bundleDir: makeBundle(platform), feed })).rejects.toThrow(
        /prerelease/
      )
      expect(feed.mutations).toEqual([])
    })

    it(`treats a public release with complete ${platformLabels[platform]} assets as already published`, async () => {
      const bundleDir = makeBundle(platform)
      const feed = new FakeFeed([release({ assets: assetsFromBundle(bundleDir, platformAssets(platform, VERSION) as string[]) })])

      const result = await publishPlatform({ platform, tag: TAG, bundleDir, feed })

      expect(result.action).toBe('complete')
      expect(feed.mutations).toEqual([])
    })

    it(`refuses complete public ${platformLabels[platform]} assets when GitHub's digest differs from the local bytes`, async () => {
      const bundleDir = makeBundle(platform)
      const assets = assetsFromBundle(bundleDir, platformAssets(platform, VERSION) as string[]).map((asset) =>
        asset.name === metadataName[platform]
          ? { ...asset, digest: `sha256:${sha256Hex(Buffer.from(`wrong-${asset.name}`))}` }
          : asset
      )
      const feed = new FakeFeed([release({ assets })])

      await expect(publishPlatform({ platform, tag: TAG, bundleDir, feed })).rejects.toThrow(/digest/)
      expect(feed.mutations).toEqual([])
    })

    it(`refuses a release that already carries partial ${platformLabels[platform]}, naming the interrupted-upload recovery`, async () => {
      const other = otherPlatform(platform)
      const partialOwn = (platformAssets(platform, VERSION) as string[]).filter((name) => name !== metadataName[platform])
      const feed = new FakeFeed([release({ assets: [...assetsFor(other), ...assetsFor(platform, partialOwn)] })])

      let caught: unknown
      try {
        await publishPlatform({ platform, tag: TAG, bundleDir: makeBundle(platform), feed })
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(Error)
      const message = caught instanceof Error ? caught.message : ''
      expect(message).toContain(metadataName[platform])
      expect(message).toContain('delete those assets')
      expect(feed.mutations).toEqual([])
    })

    it(`refuses a public release holding assets it did not publish before ${platformLabels[platform]} joins`, async () => {
      const feed = new FakeFeed([release({ assets: [...assetsFor(otherPlatform(platform)), ...assetsFor(platform, ['notes.txt'])] })])

      await expect(publishPlatform({ platform, tag: TAG, bundleDir: makeBundle(platform), feed })).rejects.toThrow()
      expect(feed.mutations).toEqual([])
    })

    it(`replaces its own partial leftover ${platformLabels[platform]} draft`, async () => {
      const feed = new FakeFeed([
        release({ id: 44, draft: true, assets: assetsFor(platform, [primaryInstaller[platform]]) })
      ])

      await publishPlatform({ platform, tag: TAG, bundleDir: makeBundle(platform), feed })

      expect(feed.mutations).toEqual(replacementMutations(platform, 44))
      expect(feed.releases).toHaveLength(1)
      expect(feed.releases[0]).toMatchObject({ tag: TAG, draft: false, prerelease: false })
      expect(feed.releases[0].assets.map((asset) => asset.name)).toEqual(platformAssets(platform, VERSION))
    })

    it(`replaces the other platform's partial leftover draft before publishing ${platformLabels[platform]}`, async () => {
      const other = otherPlatform(platform)
      const feed = new FakeFeed([
        release({ id: 45, draft: true, assets: assetsFor(other, [primaryInstaller[other]]) })
      ])

      await publishPlatform({ platform, tag: TAG, bundleDir: makeBundle(platform), feed })

      expect(feed.mutations).toEqual(replacementMutations(platform, 45))
      expect(feed.releases).toHaveLength(1)
      expect(feed.releases[0]).toMatchObject({ tag: TAG, draft: false, prerelease: false })
      expect(feed.releases[0].assets.map((asset) => asset.name)).toEqual(platformAssets(platform, VERSION))
    })

    it(`replaces an empty leftover draft before publishing ${platformLabels[platform]}`, async () => {
      const feed = new FakeFeed([release({ id: 46, draft: true, assets: [] })])

      await publishPlatform({ platform, tag: TAG, bundleDir: makeBundle(platform), feed })

      expect(feed.mutations).toEqual(replacementMutations(platform, 46))
      expect(feed.releases).toHaveLength(1)
      expect(feed.releases[0]).toMatchObject({ tag: TAG, draft: false, prerelease: false })
      expect(feed.releases[0].assets.map((asset) => asset.name)).toEqual(platformAssets(platform, VERSION))
    })

    it(`refuses a foreign leftover draft before publishing ${platformLabels[platform]}`, async () => {
      const feed = new FakeFeed([release({ draft: true, assets: assetsFor(platform, ['SHA256SUMS.txt']) })])

      await expect(publishPlatform({ platform, tag: TAG, bundleDir: makeBundle(platform), feed })).rejects.toThrow()
      expect(feed.mutations).toEqual([])
    })

    it(`re-reads a leftover ${platformLabels[platform]} draft before deleting it`, async () => {
      class PublishedOnFreshReadFeed extends FakeFeed {
        release(id: number) {
          return { ...super.release(id), draft: false }
        }
      }
      const feed = new PublishedOnFreshReadFeed([
        release({ id: 47, draft: true, assets: assetsFor(platform, [primaryInstaller[platform]]) })
      ])

      await expect(publishPlatform({ platform, tag: TAG, bundleDir: makeBundle(platform), feed })).rejects.toThrow(
        /draft/
      )
      expect(feed.mutations).not.toContain('delete 47')
      expect(feed.mutations).not.toContain('create')
    })

    it(`keeps the ${platformLabels[platform]} draft private when GitHub's digest differs from the local bytes`, async () => {
      const feed = new FakeFeed()
      feed.corruptDigests.add(primaryInstaller[platform])

      await expect(publishPlatform({ platform, tag: TAG, bundleDir: makeBundle(platform), feed })).rejects.toThrow(
        /digest/
      )
      expect(feed.releases[0].draft).toBe(true)
      expect(feed.mutations).not.toContain('publish')
    })

    it(`never uploads ${platformLabels[platform]} update metadata after an installer whose digest does not match`, async () => {
      const feed = new FakeFeed([release({ platform: otherPlatform(platform) })])
      feed.corruptDigests.add(primaryInstaller[platform])

      await expect(publishPlatform({ platform, tag: TAG, bundleDir: makeBundle(platform), feed })).rejects.toThrow()
      expect(feed.mutations).not.toContain(`upload ${metadataName[platform]}`)
    })

    it(`refuses a ${platformLabels[platform]} bundle that is not exactly the platform's set, before touching the feed`, async () => {
      const missing = new FakeFeed()
      const missingBundle = makeBundle(platform, {
        omit: (platformAssets(platform, VERSION) as string[]).find((name) => name.endsWith('.blockmap'))
      })
      await expect(publishPlatform({ platform, tag: TAG, bundleDir: missingBundle, feed: missing })).rejects.toThrow()
      expect(missing.mutations).toEqual([])
      expect(missing.listings).toBe(0)

      const extra = new FakeFeed()
      const extraBundle = makeBundle(platform, { extra: `Metis-Native-${VERSION}.zip` })
      await expect(publishPlatform({ platform, tag: TAG, bundleDir: extraBundle, feed: extra })).rejects.toThrow()
      expect(extra.mutations).toEqual([])
      expect(extra.listings).toBe(0)
    })

    it(`refuses ${platformLabels[platform]} update metadata that does not describe the bundled bytes`, async () => {
      const feed = new FakeFeed()

      await expect(
        publishPlatform({ platform, tag: TAG, bundleDir: makeBundle(platform, { wrongMetadata: true }), feed })
      ).rejects.toThrow()
      expect(feed.mutations).toEqual([])
    })
  }

  it("refuses to call the release published when GitHub's Latest pointer does not move to it", async () => {
    for (const platform of ['mac', 'win'] as Platform[]) {
      const feed = new FakeFeed()
      feed.staleLatestAfterPublish = 'v9.9.9'

      await expect(publishPlatform({ platform, tag: TAG, bundleDir: makeBundle(platform), feed })).rejects.toThrow(
        /Latest/
      )
      expect(feed.releases[0]).toMatchObject({ tag: TAG, draft: false, prerelease: false })
      expect(feed.latest).toBe('v9.9.9')
      expect(feed.mutations).toContain('publish')
    }
  })

  it('refuses a tag that is not a plain vX.Y.Z', async () => {
    for (const tag of ['v1.2.3-beta.1', '1.2.3']) {
      const feed = new FakeFeed()
      await expect(publishPlatform({ platform: 'win', tag, bundleDir: makeBundle('win'), feed })).rejects.toThrow()
      expect(feed.mutations).toEqual([])
    }
  })

  it('maps GitHub release JSON', () => {
    expect(
      toRelease({
        id: 123,
        tag_name: TAG,
        draft: false,
        prerelease: true,
        assets: [{ name: 'Metis-Setup-1.2.3.exe', size: 12, state: 'uploaded', digest: 'sha256:test' }]
      })
    ).toEqual({
      id: 123,
      tag: TAG,
      draft: false,
      prerelease: true,
      assets: [{ name: 'Metis-Setup-1.2.3.exe', size: 12, state: 'uploaded', digest: 'sha256:test' }]
    })
  })

  it('reads the feed from electron-builder.yml', () => {
    const config = ['publish:', '  provider: github', '  owner: mysticalsin', '  repo: Metis-Releases'].join('\n')
    expect(feedRepository(config)).toBe('mysticalsin/Metis-Releases')
    expect(() => feedRepository('owner: mysticalsin\n')).toThrow(/repo/)
  })
})
