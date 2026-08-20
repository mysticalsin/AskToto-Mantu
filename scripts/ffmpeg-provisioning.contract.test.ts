import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * ffmpeg-provisioning.contract.test.ts — every FFmpeg sidecar the mac chain DEMANDS must be
 * PROVISIONED by the workflow that runs it, and obtainable from the seed command the repo prints.
 *
 * Why this exists. `predist` opens with `check-ffmpeg-sidecar.mjs mac arm64 && … mac x64`, and the
 * post-package gate (`check-packaged-runtime.mjs mac --arches=arm64,x64`) hashes BOTH
 * `darwin-<arch>/ffmpeg` files out of the universal .app — so the reviewed x64 binary is
 * load-bearing, not optional. The binaries are untracked by design (.gitignore keeps only
 * manifest.json and the licence), so the only
 * way a runner or a clean clone gets one is the `ffmpeg-sidecar-v1` release. When commit cc9faf5 added
 * the x64 requirement to `predist` it added no provisioning anywhere: build.yml and release.yml cached,
 * downloaded and gated `darwin-arm64` alone, and the documented seed command created a release with two
 * assets and no mac x64 among them. Result: `npm run dist` died on predist's SECOND command with a raw
 * ENOENT — on every Mac, and in CI's own macOS job, with nothing downloadable to fix it.
 *
 * What is asserted. Not "the string x64 appears somewhere": that each arch the mac chain checks has its
 * own cache entry, its own download, its own quarantine strip and its own hard gate ordered BEFORE the
 * packaging step — and that the seed command every gate prints creates an asset for every binary the
 * tracked manifest pins. The arch list is derived from package.json rather than hard-coded, so adding a
 * third arch to `predist` fails this file until CI can actually provision it.
 *
 * Ledger: MQA-205 (no provisioning path for resources/ffmpeg/darwin-x64/ffmpeg).
 *
 * Deliberately no YAML library (js-yaml is only a transitive dependency here) — the extraction is
 * targeted and small, matching ci-cost-gates.contract.test.ts and release-gates.test.ts.
 */

const root = join(__dirname, '..')
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n')

const buildYml = read('.github', 'workflows', 'build.yml')
const releaseYml = read('.github', 'workflows', 'release.yml')
const enterpriseDoc = read('docs', 'ENTERPRISE_RELEASE.md')
const packageJson = read('package.json')
const manifest = JSON.parse(read('resources', 'ffmpeg', 'manifest.json')) as {
  binaries: Record<string, { sha256: string }>
}

/** The body of one top-level job, from its `  <name>:` line to the next job at the same indent. */
function job(source: string, name: string): string {
  const start = source.indexOf(`\n  ${name}:\n`)
  expect(start, `job not found: ${name}`).toBeGreaterThan(-1)
  const next = source.slice(start + 1).search(/\n {2}[a-z][a-z0-9-]*:\n/)
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next)
}

/** The job's steps, each without its leading `      - `. */
function steps(block: string): string[] {
  return block.split(/\n {6}- /).slice(1)
}

/** Release asset name for a manifest key, e.g. `darwin-x64/ffmpeg` -> `ffmpeg-darwin-x64`. */
function assetFor(key: string): string {
  const [dir, base] = key.split('/')
  return `ffmpeg-${dir}${base.endsWith('.exe') ? '.exe' : ''}`
}

/** Every mac arch the packaging chains actually verify — the list CI has to satisfy. */
const MAC_ARCHES = [
  ...new Set([...packageJson.matchAll(/check-ffmpeg-sidecar\.mjs mac ([a-z0-9]+)/g)].map((m) => m[1]))
]

const CHAINS = [
  { label: 'build.yml / build-macos', source: buildYml, job: 'build-macos', packages: 'npm run dist' },
  {
    label: 'release.yml / release-macos',
    source: releaseYml,
    job: 'release-macos',
    packages: 'npm run release:build:mac'
  }
] as const

describe('ffmpeg provisioning — CI must provision every mac arch the build checks', () => {
  it('reads the arch list off package.json (premise guard)', () => {
    expect(MAC_ARCHES.length, 'no `check-ffmpeg-sidecar.mjs mac <arch>` found in package.json').toBeGreaterThan(0)
    expect(MAC_ARCHES).toContain('arm64')
    expect(MAC_ARCHES).toContain('x64')
  })

  for (const chain of CHAINS) {
    describe(chain.label, () => {
      for (const arch of MAC_ARCHES) {
        it(`provisions darwin-${arch} from the ffmpeg-sidecar-v1 release, and gates on it`, () => {
          const all = steps(job(chain.source, chain.job))
          const dir = `resources/ffmpeg/darwin-${arch}`
          const asset = `ffmpeg-darwin-${arch}`

          const cache = all.find((s) => s.startsWith('uses: actions/cache@v4') && s.includes(`path: ${dir}\n`))
          expect(cache, `no actions/cache step caches ${dir}`).toBeDefined()
          expect(cache).toContain(`key: ffmpeg-sidecar-v1-darwin-${arch}-`)
          const id = cache?.match(/\n\s+id: (\S+)/)?.[1]
          expect(id, `the cache step for ${dir} has no id, so nothing can gate on its cache-hit`).toBeTruthy()

          const provisionIndex = all.findIndex((s) => s.includes(`--pattern '${asset}'`))
          expect(provisionIndex, `nothing downloads the ${asset} release asset`).toBeGreaterThan(-1)
          const provision = all[provisionIndex]
          // Its OWN cache id. Sharing one id across arches skips this download entirely whenever the
          // other arch's cache hits — which is exactly when the gate below would then fire.
          expect(provision).toContain(`if: steps.${id}.outputs.cache-hit != 'true'`)
          expect(provision).toContain(`mv resources/ffmpeg/${asset} ${dir}/ffmpeg`)
          expect(provision).toContain(`chmod +x ${dir}/ffmpeg`)
          // A freshly downloaded unsigned Mach-O is quarantined, and Gatekeeper then kills it when
          // check-ffmpeg-sidecar.mjs runs it to read the licence banner. Trust comes from the sha256.
          expect(provision).toContain(`xattr -d com.apple.quarantine ${dir}/ffmpeg`)

          const gateIndex = all.findIndex((s) => s.includes(`[ ! -f "${dir}/ffmpeg" ]`))
          expect(gateIndex, `no hard gate requires ${dir}/ffmpeg to be present`).toBeGreaterThan(-1)
          expect(all[gateIndex], 'the gate must fail the job, not warn').toContain('exit 1')
          expect(all[gateIndex], 'the gate must name the release that provisions it').toContain('ffmpeg-sidecar-v1')

          const packagesIndex = all.findIndex((s) => s.includes(chain.packages))
          expect(packagesIndex, `job never runs ${chain.packages}`).toBeGreaterThan(-1)
          expect(gateIndex, 'the gate must run BEFORE packaging, not after').toBeLessThan(packagesIndex)
        })
      }

      it('gives each arch its own cache entry — one shared id skips the other arch on a cache hit', () => {
        const caches = steps(job(chain.source, chain.job)).filter(
          (s) => s.startsWith('uses: actions/cache@v4') && s.includes('path: resources/ffmpeg/')
        )
        expect(caches.length).toBe(MAC_ARCHES.length)
        const ids = caches.map((s) => s.match(/\n\s+id: (\S+)/)?.[1])
        const keys = caches.map((s) => s.match(/\n\s+key: (\S+)/)?.[1])
        expect(new Set(ids).size, `duplicate cache id: ${ids.join(', ')}`).toBe(caches.length)
        expect(new Set(keys).size, `duplicate cache key: ${keys.join(', ')}`).toBe(caches.length)
      })
    })
  }
})

describe('ffmpeg provisioning — the seed command must create every asset the workflows download', () => {
  const assets = Object.keys(manifest.binaries).map((key) => ({ key, asset: assetFor(key) }))

  /** Assert one rendering of the one-time seed instructions covers every pinned binary. */
  function assertSeedIsComplete(text: string, where: string): void {
    const create = text.slice(text.indexOf('gh release create ffmpeg-sidecar-v1'))
    for (const { key, asset } of assets) {
      expect(text, `${where} never stages ${key}`).toContain(`cp resources/ffmpeg/${key} /tmp/${asset}`)
      expect(create, `${where} creates the release without /tmp/${asset}`).toContain(`/tmp/${asset}`)
    }
  }

  it('pins all three reviewed binaries (premise guard)', () => {
    expect(assets.map((a) => a.asset).sort()).toEqual([
      'ffmpeg-darwin-arm64',
      'ffmpeg-darwin-x64',
      'ffmpeg-win32-x64.exe'
    ])
  })

  for (const [label, source] of [
    ['build.yml', buildYml],
    ['release.yml', releaseYml]
  ] as const) {
    it(`${label}'s hard gates print a seed command that produces every asset`, () => {
      const lines = source.split('\n').filter((l) => l.includes('gh release create ffmpeg-sidecar-v1'))
      expect(lines.length, `${label} prints no seed command`).toBeGreaterThan(0)
      lines.forEach((line, i) => assertSeedIsComplete(line, `${label} seed command #${i + 1}`))
    })
  }

  it('docs/ENTERPRISE_RELEASE.md seeds the release with every asset', () => {
    const blocks = (enterpriseDoc.match(/```bash\n[\s\S]*?```/g) ?? []).filter((b) =>
      b.includes('gh release create ffmpeg-sidecar-v1')
    )
    expect(blocks.length, 'ENTERPRISE_RELEASE.md has no ffmpeg seed block').toBe(1)
    assertSeedIsComplete(blocks[0], 'ENTERPRISE_RELEASE.md seed block')
  })

  it('docs/ENTERPRISE_RELEASE.md says how the darwin-x64 asset is produced', () => {
    // It is the one asset that cannot be built by simply running the script on the target machine —
    // it is cross-compiled from Apple Silicon, and the prerequisites are not obvious from a failure.
    expect(enterpriseDoc).toContain('build-ffmpeg-sidecar-mac.sh x64')
    expect(enterpriseDoc).toMatch(/nasm/)
    expect(enterpriseDoc).toMatch(/Rosetta 2/)
  })
})
