import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import {
  buildRuntimeManifest,
  cachePathForAsset,
  catalogDownloadPlan,
  hashFile,
  loadCatalog,
  resolveCatalogSelection,
  selectedAssets,
  serializeRuntimeManifest,
  validateCatalog,
  verifyPayload,
  verifySelectedCache,
  verifyTrackedRecords
} from './local-ai-manifest.mjs'
import { checkLocalAi } from './check-local-ai.mjs'
import { downloadAsset, fetchLocalAi } from './fetch-local-ai.mjs'
import { parseStageArgs, stageLocalAi } from './stage-local-ai.mjs'

const COMMIT_A = 'a'.repeat(40)
const COMMIT_B = 'b'.repeat(40)
const COMMIT_C = 'c'.repeat(40)
const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const SHA_C = 'c'.repeat(64)
const SHA_D = 'd'.repeat(64)
const SHA_E = 'e'.repeat(64)
const SHA_F = 'f'.repeat(64)

function makeAsset(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'text-weights',
    variantId: 'text-qwen3-0.6b-q8',
    component: 'weights',
    source: {
      repo: 'fixture-org/qwen3-0.6b',
      commit: COMMIT_A,
      path: 'model.gguf',
      bytes: 1024,
      sha256: SHA_A,
      licenseId: 'qwen-license'
    },
    destination: 'text/qwen3-0.6b/model.gguf',
    platforms: ['all'],
    ...overrides
  }
}

function makeCatalog(overrides: Record<string, unknown> = {}): any {
  return {
    schemaVersion: 1,
    selected: {
      textVariant: 'text-qwen3-0.6b-q8',
      visionVariant: 'vision-smolvlm-q8',
      approval: 'evaluation'
    },
    variants: [
      {
        id: 'text-qwen3-0.6b-q8',
        role: 'text',
        model: 'qwen3-0.6b',
        precision: 'q8',
        runtime: 'node-llama-cpp',
        componentIds: ['weights'],
        provenance: { status: 'complete', noticeIds: [] }
      },
      {
        id: 'text-qwen3-1.7b-iq4',
        role: 'text',
        model: 'qwen3-1.7b',
        precision: 'iq4_xs',
        runtime: 'node-llama-cpp',
        componentIds: ['weights'],
        provenance: { status: 'review-required', noticeIds: ['compact-provenance'] }
      },
      {
        id: 'vision-smolvlm-q8',
        role: 'vision',
        model: 'smolvlm-256m-instruct',
        precision: 'q8',
        runtime: 'transformers.js',
        componentIds: ['weights'],
        provenance: { status: 'complete', noticeIds: [] }
      }
    ],
    assets: [
      makeAsset(),
      makeAsset({
        id: 'candidate-text-weights',
        variantId: 'text-qwen3-1.7b-iq4',
        source: {
          repo: 'fixture-org/qwen3-1.7b',
          commit: COMMIT_B,
          path: 'model-iq4.gguf',
          bytes: 1536,
          sha256: SHA_B,
          licenseId: 'qwen-license'
        },
        destination: 'text/qwen3-1.7b/model-iq4.gguf'
      }),
      makeAsset({
        id: 'vision-weights',
        variantId: 'vision-smolvlm-q8',
        source: {
          repo: 'fixture-org/smolvlm',
          commit: COMMIT_C,
          path: 'model.onnx',
          bytes: 2048,
          sha256: SHA_C,
          licenseId: 'smolvlm-license'
        },
        destination: 'vision/smolvlm/model.onnx'
      })
    ],
    licenses: [
      {
        id: 'qwen-license',
        path: 'resources/local-ai/licenses/Qwen-Apache-2.0.txt',
        bytes: 10,
        sha256: SHA_D
      },
      {
        id: 'smolvlm-license',
        path: 'resources/local-ai/licenses/SmolVLM-Apache-2.0.txt',
        bytes: 10,
        sha256: SHA_E
      }
    ],
    notices: [
      {
        id: 'compact-provenance',
        kind: 'provenance',
        path: 'resources/local-ai/licenses/model-conversion-notices.md',
        bytes: 10,
        sha256: SHA_F
      }
    ],
    ...overrides
  }
}

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'metis-local-ai-manifest-'))
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

const sha256 = (value: Buffer | string): string =>
  createHash('sha256').update(value).digest('hex')

function writeTiny(root: string, relativePath: string, value: Buffer | string): string {
  const file = join(root, relativePath)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, value)
  return file
}

function listFiles(root: string): string[] {
  const files: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else files.push(relative(root, absolute).split(sep).join('/'))
    }
  }
  visit(root)
  return files.sort()
}

function makeTinyFixture(): {
  repoRoot: string
  cacheRoot: string
  payloadRoot: string
  catalog: any
  catalogSha256: string
  contents: Record<string, Buffer>
} {
  const repoRoot = join(tmpRoot, 'repo')
  const cacheRoot = join(tmpRoot, 'cache')
  const payloadRoot = join(tmpRoot, 'payload')
  const contents = {
    text: Buffer.from('tiny-text-weights'),
    vision: Buffer.from('tiny-vision-weights'),
    qwenLicense: Buffer.from('tiny-qwen-license'),
    visionLicense: Buffer.from('tiny-vision-license'),
    provenance: Buffer.from('tiny-provenance-notice')
  }
  const catalog = makeCatalog()

  const text = catalog.assets.find((asset: any) => asset.id === 'text-weights')
  text.source.bytes = contents.text.length
  text.source.sha256 = sha256(contents.text)
  const vision = catalog.assets.find((asset: any) => asset.id === 'vision-weights')
  vision.source.bytes = contents.vision.length
  vision.source.sha256 = sha256(contents.vision)

  catalog.licenses[0].bytes = contents.qwenLicense.length
  catalog.licenses[0].sha256 = sha256(contents.qwenLicense)
  catalog.licenses[1].bytes = contents.visionLicense.length
  catalog.licenses[1].sha256 = sha256(contents.visionLicense)
  catalog.notices[0].bytes = contents.provenance.length
  catalog.notices[0].sha256 = sha256(contents.provenance)
  validateCatalog(catalog)

  writeTiny(repoRoot, catalog.licenses[0].path, contents.qwenLicense)
  writeTiny(repoRoot, catalog.licenses[1].path, contents.visionLicense)
  writeTiny(repoRoot, catalog.notices[0].path, contents.provenance)
  writeTiny(cacheRoot, relative(cacheRoot, cachePathForAsset(cacheRoot, text)), contents.text)
  writeTiny(cacheRoot, relative(cacheRoot, cachePathForAsset(cacheRoot, vision)), contents.vision)

  return {
    repoRoot,
    cacheRoot,
    payloadRoot,
    catalog,
    catalogSha256: sha256(JSON.stringify(catalog)),
    contents
  }
}

describe('validateCatalog', () => {
  it('accepts a valid synthetic catalog', () => {
    expect(() => validateCatalog(makeCatalog())).not.toThrow()
  })

  it('rejects unknown top-level and nested keys', () => {
    expect(() => validateCatalog({ ...makeCatalog(), extra: true })).toThrow()
    const nested = makeCatalog()
    nested.assets[0] = { ...nested.assets[0], extra: true }
    expect(() => validateCatalog(nested)).toThrow()
  })

  it('rejects duplicate IDs', () => {
    const catalog = makeCatalog()
    catalog.assets[1].id = catalog.assets[0].id
    expect(() => validateCatalog(catalog)).toThrow()
  })

  it('rejects non-immutable or placeholder commits and hashes', () => {
    for (const commit of ['main', 'not-a-commit', '0'.repeat(40)]) {
      const catalog = makeCatalog()
      catalog.assets[0].source.commit = commit
      expect(() => validateCatalog(catalog), commit).toThrow()
    }
    for (const sha256 of ['not-a-hash', '0'.repeat(64)]) {
      const catalog = makeCatalog()
      catalog.assets[0].source.sha256 = sha256
      expect(() => validateCatalog(catalog), sha256).toThrow()
    }
  })

  it('rejects non-positive, fractional, and unsafe sizes', () => {
    for (const bytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const catalog = makeCatalog()
      catalog.assets[0].source.bytes = bytes
      expect(() => validateCatalog(catalog), String(bytes)).toThrow()
    }
  })

  it('rejects unsafe destination forms', () => {
    for (const destination of [
      '/abs/path.gguf',
      'C:\\win\\path.gguf',
      '\\\\unc\\share\\path.gguf',
      '../escape.gguf',
      './dot.gguf',
      'dir/../escape.gguf',
      'dir/./dot.gguf',
      'dir//empty.gguf',
      'dir\\backslash.gguf',
      'path?query=1',
      'path#fragment',
      'CON/model.gguf',
      'text/COM¹/model.gguf',
      'text/LPT³/model.gguf',
      'text/model.gguf.part',
      'manifest.json',
      'path\u0000null.gguf'
    ]) {
      const catalog = makeCatalog()
      catalog.assets[0].destination = destination
      expect(() => validateCatalog(catalog), destination).toThrow()
    }
  })

  it('rejects unsafe source and tracked-record paths', () => {
    const source = makeCatalog()
    source.assets[0].source.path = '../model.gguf'
    expect(() => validateCatalog(source)).toThrow()

    const license = makeCatalog()
    license.licenses[0].path = '/tmp/LICENSE'
    expect(() => validateCatalog(license)).toThrow()
  })

  it('rejects case-fold destination collisions', () => {
    const catalog = makeCatalog()
    catalog.assets[1].destination = catalog.assets[0].destination.toUpperCase()
    expect(() => validateCatalog(catalog)).toThrow()

    const unicode = makeCatalog()
    unicode.assets[0].destination = 'text/é.gguf'
    unicode.assets[1].destination = 'TEXT/e\u0301.gguf'
    expect(() => validateCatalog(unicode)).toThrow()
  })

  it('rejects incomplete or extra component closure per variant', () => {
    const missing = makeCatalog()
    missing.variants[0].componentIds = ['weights', 'tokenizer']
    expect(() => validateCatalog(missing)).toThrow()

    const extra = makeCatalog()
    extra.assets.push(
      makeAsset({
        id: 'stray-asset',
        variantId: 'text-qwen3-0.6b-q8',
        component: 'stray',
        destination: 'text/qwen3-0.6b/stray.bin'
      })
    )
    expect(() => validateCatalog(extra)).toThrow()
  })

  it('rejects invalid role, model, runtime, or selected-role combinations', () => {
    const model = makeCatalog()
    model.variants[0].model = 'smolvlm-256m-instruct'
    expect(() => validateCatalog(model)).toThrow()

    const selected = makeCatalog()
    selected.selected.textVariant = 'vision-smolvlm-q8'
    expect(() => validateCatalog(selected)).toThrow()
  })

  it('rejects invalid platform arrays', () => {
    for (const platforms of [[], ['darwin-arm64', 'darwin-arm64'], ['all', 'darwin-arm64'], ['linux-x64']]) {
      const catalog = makeCatalog()
      catalog.assets[0].platforms = platforms
      expect(() => validateCatalog(catalog), JSON.stringify(platforms)).toThrow()
    }
  })

  it('rejects unknown license and notice references', () => {
    const badLicense = makeCatalog()
    badLicense.assets[0].source.licenseId = 'missing-license'
    expect(() => validateCatalog(badLicense)).toThrow()

    const badNotice = makeCatalog()
    badNotice.variants[1].provenance.noticeIds = ['missing-notice']
    expect(() => validateCatalog(badNotice)).toThrow()
  })
})

describe('buildRuntimeManifest release gate', () => {
  function reviewRequiredRelease(): any {
    const catalog = makeCatalog()
    catalog.selected = {
      textVariant: 'text-qwen3-1.7b-iq4',
      visionVariant: 'vision-smolvlm-q8',
      approval: 'release'
    }
    return catalog
  }

  it('rejects review-required release provenance without a release-exception notice', () => {
    const catalog = reviewRequiredRelease()
    validateCatalog(catalog)
    expect(() =>
      buildRuntimeManifest({
        catalog,
        catalogSha256: SHA_A,
        selection: catalog.selected,
        platform: 'darwin-arm64'
      })
    ).toThrow()
  })

  it('accepts release provenance with a referenced release-exception notice', () => {
    const catalog = reviewRequiredRelease()
    catalog.notices.push({
      id: 'release-exception',
      kind: 'release-exception',
      path: 'resources/local-ai/licenses/release-exception.md',
      bytes: 10,
      sha256: SHA_B
    })
    catalog.variants[1].provenance.noticeIds.push('release-exception')
    validateCatalog(catalog)
    const manifest = buildRuntimeManifest({
      catalog,
      catalogSha256: SHA_A,
      selection: catalog.selected,
      platform: 'darwin-arm64'
    })
    expect(manifest.approval).toBe('release')
  })
})

describe('serializeRuntimeManifest', () => {
  it('sorts records deterministically and emits exactly one trailing newline', () => {
    const catalog = makeCatalog()
    const reversed = structuredClone(catalog)
    reversed.variants.reverse()
    reversed.assets.reverse()
    reversed.licenses.reverse()
    reversed.notices.reverse()

    validateCatalog(catalog)
    validateCatalog(reversed)
    const build = (value: any) =>
      buildRuntimeManifest({
        catalog: value,
        catalogSha256: SHA_A,
        selection: value.selected,
        platform: 'darwin-arm64'
      })
    const first = serializeRuntimeManifest(build(catalog))
    const second = serializeRuntimeManifest(build(reversed))
    expect(first).toBe(second)
    expect(first.endsWith('\n')).toBe(true)
    expect(first.endsWith('\n\n')).toBe(false)
  })
})

describe('catalogDownloadPlan', () => {
  it('plans only the two selected model assets by default', () => {
    const catalog = makeCatalog()
    validateCatalog(catalog)
    expect(catalogDownloadPlan(catalog).map((entry: any) => entry.id).sort()).toEqual([
      'text-weights',
      'vision-weights'
    ])
  })

  it('plans every candidate model asset only with allCandidates', () => {
    const catalog = makeCatalog()
    validateCatalog(catalog)
    expect(
      catalogDownloadPlan(catalog, { allCandidates: true })
        .map((entry: any) => entry.id)
        .sort()
    ).toEqual(['candidate-text-weights', 'text-weights', 'vision-weights'])
  })
})

describe('catalog and file integrity', () => {
  it('validates the tracked five-variant catalog and exact upstream license records', async () => {
    const repoRoot = resolve(process.cwd())
    const loaded = loadCatalog(join(repoRoot, 'resources/local-ai/candidates.json'))
    expect(loaded.catalog.variants).toHaveLength(5)
    expect(loaded.catalog.assets).toHaveLength(21)
    expect(loaded.catalog.selected).toEqual({
      textVariant: 'qwen3-0.6b-q8-0',
      visionVariant: 'smolvlm-256m-instruct-q8',
      approval: 'evaluation'
    })
    expect(
      loaded.catalog.variants.find((variant: any) => variant.id === 'smolvlm-256m-instruct-q8').precision
    ).toBe('Q8')
    await expect(
      verifyTrackedRecords({ catalog: loaded.catalog, repoRoot })
    ).resolves.toBeUndefined()
  })

  it('loads and validates the raw catalog with its exact SHA-256', () => {
    const catalog = makeCatalog()
    const raw = `${JSON.stringify(catalog, null, 2)}\n`
    const file = writeTiny(tmpRoot, 'candidates.json', raw)
    const loaded = loadCatalog(file)
    expect(loaded.catalog).toEqual(catalog)
    expect(loaded.catalogSha256).toBe(sha256(raw))
  })

  it('streams file hashes and uses the fixed cache layout', async () => {
    const value = Buffer.from('streaming-hash-fixture')
    const file = writeTiny(tmpRoot, 'hash.bin', value)
    await expect(hashFile(file)).resolves.toBe(sha256(value))

    const cacheRoot = join(tmpRoot, 'cache')
    const asset = makeAsset()
    const cacheFile = cachePathForAsset(cacheRoot, asset)
    expect(cacheFile).toBe(join(cacheRoot, asset.id, basename(asset.source.path)))
    expect(relative(cacheRoot, cacheFile).startsWith('..')).toBe(false)
  })

  it('verifies exact tracked license and provenance records', async () => {
    const fixture = makeTinyFixture()
    await expect(
      verifyTrackedRecords({ catalog: fixture.catalog, repoRoot: fixture.repoRoot })
    ).resolves.toBeUndefined()
  })

  it('rejects a one-byte tracked-record mutation', async () => {
    const fixture = makeTinyFixture()
    writeFileSync(join(fixture.repoRoot, fixture.catalog.licenses[0].path), 'x')
    await expect(
      verifyTrackedRecords({ catalog: fixture.catalog, repoRoot: fixture.repoRoot })
    ).rejects.toThrow()
  })

  it('rejects a symlinked tracked record', async () => {
    const fixture = makeTinyFixture()
    const recordFile = join(fixture.repoRoot, fixture.catalog.licenses[0].path)
    const realFile = writeTiny(tmpRoot, 'outside-license.txt', fixture.contents.qwenLicense)
    rmSync(recordFile)
    symlinkSync(realFile, recordFile)
    await expect(
      verifyTrackedRecords({ catalog: fixture.catalog, repoRoot: fixture.repoRoot })
    ).rejects.toThrow()
  })

  it('rejects a hardlinked tracked record', async () => {
    const fixture = makeTinyFixture()
    const recordFile = join(fixture.repoRoot, fixture.catalog.licenses[0].path)
    linkSync(recordFile, join(tmpRoot, 'hardlinked-license.txt'))
    await expect(
      verifyTrackedRecords({ catalog: fixture.catalog, repoRoot: fixture.repoRoot })
    ).rejects.toThrow()
  })
})

describe('selected cache verification', () => {
  it('verifies selected assets without requiring the unselected candidate', async () => {
    const fixture = makeTinyFixture()
    const selection = resolveCatalogSelection(fixture.catalog)
    const candidate = fixture.catalog.assets.find((asset: any) => asset.id === 'candidate-text-weights')
    expect(() => statSync(cachePathForAsset(fixture.cacheRoot, candidate))).toThrow()
    await expect(
      verifySelectedCache({
        catalog: fixture.catalog,
        cacheRoot: fixture.cacheRoot,
        selection,
        platform: 'darwin-arm64'
      })
    ).resolves.toBeUndefined()
  })

  it.each(['mutated', 'missing', 'symlink'])('rejects a %s selected asset', async (failure) => {
    const fixture = makeTinyFixture()
    const selection = resolveCatalogSelection(fixture.catalog)
    const text = fixture.catalog.assets.find((asset: any) => asset.id === 'text-weights')
    const cacheFile = cachePathForAsset(fixture.cacheRoot, text)
    if (failure === 'mutated') writeFileSync(cacheFile, 'mutated')
    if (failure === 'missing') rmSync(cacheFile)
    if (failure === 'symlink') {
      const realFile = writeTiny(tmpRoot, 'outside-model.gguf', fixture.contents.text)
      rmSync(cacheFile)
      symlinkSync(realFile, cacheFile)
    }
    await expect(
      verifySelectedCache({
        catalog: fixture.catalog,
        cacheRoot: fixture.cacheRoot,
        selection,
        platform: 'darwin-arm64'
      })
    ).rejects.toThrow()
  })
})

describe('deterministic selected-only staging', () => {
  it('requires --evaluation and both variant IDs for every override', () => {
    expect(() =>
      parseStageArgs(['--platform', 'darwin-arm64', '--text-variant', 'qwen3-1.7b-iq4-xs'])
    ).toThrow()
    expect(() =>
      parseStageArgs([
        '--platform',
        'darwin-arm64',
        '--evaluation',
        '--text-variant',
        'qwen3-1.7b-iq4-xs',
        '--vision-variant',
        'smolvlm-256m-instruct-q8'
      ])
    ).not.toThrow()
  })

  it('copies exact selected files, never hardlinks, and stages byte-identically twice', async () => {
    const fixture = makeTinyFixture()
    const selection = resolveCatalogSelection(fixture.catalog)
    const stage = () =>
      stageLocalAi({
        ...fixture,
        selection,
        platform: 'darwin-arm64'
      })

    await stage()
    const firstManifest = readFileSync(join(fixture.payloadRoot, 'manifest.json'))
    const selected = selectedAssets(fixture.catalog, selection, 'darwin-arm64')
    for (const asset of selected) {
      const cacheFile = cachePathForAsset(fixture.cacheRoot, asset)
      const payloadFile = join(fixture.payloadRoot, asset.destination)
      expect(lstatSync(payloadFile).isSymbolicLink()).toBe(false)
      expect(statSync(payloadFile).ino).not.toBe(statSync(cacheFile).ino)
      expect(readFileSync(payloadFile)).toEqual(readFileSync(cacheFile))
    }
    expect(listFiles(fixture.payloadRoot)).toEqual(
      [
        ...selected.map((asset: any) => asset.destination),
        'licenses/Qwen-Apache-2.0.txt',
        'licenses/SmolVLM-Apache-2.0.txt',
        'manifest.json'
      ].sort()
    )
    expect(listFiles(fixture.payloadRoot)).not.toContain('notices/model-conversion-notices.md')
    expect(listFiles(fixture.payloadRoot)).not.toContain('text/qwen3-1.7b/model-iq4.gguf')

    await stage()
    expect(readFileSync(join(fixture.payloadRoot, 'manifest.json'))).toEqual(firstManifest)
    await expect(
      verifyPayload({
        catalog: fixture.catalog,
        catalogSha256: fixture.catalogSha256,
        payloadRoot: fixture.payloadRoot,
        platform: 'darwin-arm64'
      })
    ).resolves.toBeDefined()
  })

  it('preserves the previous payload when a new stage fails', async () => {
    const fixture = makeTinyFixture()
    mkdirSync(fixture.payloadRoot, { recursive: true })
    writeFileSync(join(fixture.payloadRoot, 'sentinel.txt'), 'previous-payload')
    const text = fixture.catalog.assets.find((asset: any) => asset.id === 'text-weights')
    rmSync(cachePathForAsset(fixture.cacheRoot, text))

    await expect(
      stageLocalAi({
        ...fixture,
        selection: resolveCatalogSelection(fixture.catalog),
        platform: 'darwin-arm64'
      })
    ).rejects.toThrow()
    expect(readFileSync(join(fixture.payloadRoot, 'sentinel.txt'), 'utf8')).toBe('previous-payload')
  })
})

describe('exact payload verification', () => {
  async function stagedFixture(): Promise<ReturnType<typeof makeTinyFixture>> {
    const fixture = makeTinyFixture()
    await stageLocalAi({
      ...fixture,
      selection: resolveCatalogSelection(fixture.catalog),
      platform: 'darwin-arm64'
    })
    return fixture
  }

  it.each(['extra', 'part', 'mutated', 'symlink'])('rejects a payload with a %s file', async (failure) => {
    const fixture = await stagedFixture()
    const textFile = join(fixture.payloadRoot, 'text/qwen3-0.6b/model.gguf')
    if (failure === 'extra') writeTiny(fixture.payloadRoot, 'extra.bin', 'x')
    if (failure === 'part') writeTiny(fixture.payloadRoot, 'model.part', 'x')
    if (failure === 'mutated') writeFileSync(textFile, 'mutated')
    if (failure === 'symlink') {
      const realFile = writeTiny(tmpRoot, 'outside-payload.gguf', fixture.contents.text)
      rmSync(textFile)
      symlinkSync(realFile, textFile)
    }
    await expect(
      verifyPayload({
        catalog: fixture.catalog,
        catalogSha256: fixture.catalogSha256,
        payloadRoot: fixture.payloadRoot,
        platform: 'darwin-arm64'
      })
    ).rejects.toThrow()
  })

  it('rejects platform, catalog-hash, and release-approval mismatches', async () => {
    const fixture = await stagedFixture()
    await expect(
      verifyPayload({ ...fixture, platform: 'win32-x64' })
    ).rejects.toThrow()
    await expect(
      verifyPayload({ ...fixture, catalogSha256: SHA_A, platform: 'darwin-arm64' })
    ).rejects.toThrow()
    await expect(
      verifyPayload({ ...fixture, platform: 'darwin-arm64', requireRelease: true })
    ).rejects.toThrow()
  })
})

describe('offline check', () => {
  it('returns an actionable fetch hint without attempting network access', async () => {
    const fixture = makeTinyFixture()
    rmSync(fixture.cacheRoot, { recursive: true })
    mkdirSync(fixture.cacheRoot, { recursive: true })
    let networkCalls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      networkCalls++
      throw new Error('network forbidden')
    }) as typeof fetch
    try {
      const result = await checkLocalAi({
        catalog: fixture.catalog,
        catalogSha256: fixture.catalogSha256,
        repoRoot: fixture.repoRoot,
        cacheRoot: fixture.cacheRoot,
        selection: resolveCatalogSelection(fixture.catalog),
        platform: 'darwin-arm64'
      })
      expect(result.ready).toBe(false)
      expect(result.hint).toMatch(/fetch/i)
      expect(networkCalls).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('rejects an evaluation selection when release approval is required', async () => {
    const fixture = makeTinyFixture()
    await expect(
      checkLocalAi({
        catalog: fixture.catalog,
        catalogSha256: fixture.catalogSha256,
        repoRoot: fixture.repoRoot,
        cacheRoot: fixture.cacheRoot,
        selection: resolveCatalogSelection(fixture.catalog),
        platform: 'darwin-arm64',
        requireRelease: true
      })
    ).rejects.toThrow()
  })
})

describe('downloadAsset', () => {
  const tinyAsset = (bytes: Buffer): any =>
    makeAsset({
      source: {
        repo: 'fixture-org/qwen3-0.6b',
        commit: COMMIT_A,
        path: 'model.gguf',
        bytes: bytes.length,
        sha256: sha256(bytes),
        licenseId: 'qwen-license'
      }
    })
  const response = (bytes: Buffer, status: number, headers?: HeadersInit): Response =>
    new Response(new Uint8Array(bytes), { status, headers })

  it('streams a fresh 200 response into the final file and removes .part', async () => {
    const bytes = Buffer.from('tiny-download-fixture')
    const asset = tinyAsset(bytes)
    const cacheRoot = join(tmpRoot, 'cache')
    const finalFile = cachePathForAsset(cacheRoot, asset)
    let calls = 0
    await downloadAsset({
      asset,
      cacheRoot,
      fetchImpl: async () => {
        calls++
        return response(bytes, 200)
      }
    })
    expect(calls).toBe(1)
    expect(readFileSync(finalFile)).toEqual(bytes)
    expect(() => statSync(`${finalFile}.part`)).toThrow()
  })

  it('rehashes a valid existing final file without fetching', async () => {
    const bytes = Buffer.from('already-complete-fixture')
    const asset = tinyAsset(bytes)
    const cacheRoot = join(tmpRoot, 'cache')
    const finalFile = cachePathForAsset(cacheRoot, asset)
    writeTiny(cacheRoot, relative(cacheRoot, finalFile), bytes)
    let calls = 0
    await downloadAsset({
      asset,
      cacheRoot,
      fetchImpl: async () => {
        calls++
        throw new Error('fetch must not run')
      }
    })
    expect(calls).toBe(0)
    expect(readFileSync(finalFile)).toEqual(bytes)
  })

  it('resumes a partial with an exact Range request and 206 Content-Range', async () => {
    const bytes = Buffer.from('partial-download-fixture')
    const asset = tinyAsset(bytes)
    const cacheRoot = join(tmpRoot, 'cache')
    const finalFile = cachePathForAsset(cacheRoot, asset)
    const offset = 10
    writeTiny(cacheRoot, relative(cacheRoot, `${finalFile}.part`), bytes.subarray(0, offset))
    let seenRange = ''
    await downloadAsset({
      asset,
      cacheRoot,
      fetchImpl: async (_url: string, init?: RequestInit) => {
        seenRange = new Headers(init?.headers).get('range') ?? ''
        return response(bytes.subarray(offset), 206, {
          'Content-Range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}`
        })
      }
    })
    expect(seenRange).toBe(`bytes=${offset}-${bytes.length - 1}`)
    expect(readFileSync(finalFile)).toEqual(bytes)
    expect(() => statSync(`${finalFile}.part`)).toThrow()
  })

  it('truncates and restarts when a Range request receives a full 200 response', async () => {
    const bytes = Buffer.from('restart-on-full-response-fixture')
    const asset = tinyAsset(bytes)
    const cacheRoot = join(tmpRoot, 'cache')
    const finalFile = cachePathForAsset(cacheRoot, asset)
    writeTiny(cacheRoot, relative(cacheRoot, `${finalFile}.part`), Buffer.from('stale'))
    await downloadAsset({
      asset,
      cacheRoot,
      fetchImpl: async () => response(bytes, 200)
    })
    expect(readFileSync(finalFile)).toEqual(bytes)
    expect(() => statSync(`${finalFile}.part`)).toThrow()
  })

  it('preserves a clean short response as a resumable partial', async () => {
    const bytes = Buffer.from('short-response-resume-fixture')
    const asset = tinyAsset(bytes)
    const cacheRoot = join(tmpRoot, 'cache')
    const finalFile = cachePathForAsset(cacheRoot, asset)
    const firstChunk = bytes.subarray(0, 8)
    await expect(
      downloadAsset({
        asset,
        cacheRoot,
        fetchImpl: async () => response(firstChunk, 200)
      })
    ).rejects.toThrow()
    expect(readFileSync(`${finalFile}.part`)).toEqual(firstChunk)

    await downloadAsset({
      asset,
      cacheRoot,
      fetchImpl: async () =>
        response(bytes.subarray(firstChunk.length), 206, {
          'Content-Range': `bytes ${firstChunk.length}-${bytes.length - 1}/${bytes.length}`
        })
    })
    expect(readFileSync(finalFile)).toEqual(bytes)
  })

  it('finalizes a complete valid .part file without fetching', async () => {
    const bytes = Buffer.from('complete-part-fixture')
    const asset = tinyAsset(bytes)
    const cacheRoot = join(tmpRoot, 'cache')
    const finalFile = cachePathForAsset(cacheRoot, asset)
    writeTiny(cacheRoot, relative(cacheRoot, `${finalFile}.part`), bytes)
    let calls = 0
    await downloadAsset({
      asset,
      cacheRoot,
      fetchImpl: async () => {
        calls++
        throw new Error('fetch must not run')
      }
    })
    expect(calls).toBe(0)
    expect(readFileSync(finalFile)).toEqual(bytes)
  })

  it('rejects oversize partials and mismatched Content-Range without a final file', async () => {
    const bytes = Buffer.from('mismatch-content-range-fixture')
    const asset = tinyAsset(bytes)

    const oversizeRoot = join(tmpRoot, 'cache-oversize')
    const oversizeFinal = cachePathForAsset(oversizeRoot, asset)
    writeTiny(
      oversizeRoot,
      relative(oversizeRoot, `${oversizeFinal}.part`),
      Buffer.concat([bytes, Buffer.from('x')])
    )
    await expect(
      downloadAsset({ asset, cacheRoot: oversizeRoot, fetchImpl: async () => response(bytes, 200) })
    ).rejects.toThrow()
    expect(() => statSync(oversizeFinal)).toThrow()

    const mismatchRoot = join(tmpRoot, 'cache-mismatch')
    const mismatchFinal = cachePathForAsset(mismatchRoot, asset)
    const partial = bytes.subarray(0, 5)
    const mismatchPart = `${mismatchFinal}.part`
    writeTiny(mismatchRoot, relative(mismatchRoot, mismatchPart), partial)
    await expect(
      downloadAsset({
        asset,
        cacheRoot: mismatchRoot,
        fetchImpl: async () =>
          response(bytes.subarray(5), 206, {
            'Content-Range': `bytes 6-${bytes.length - 1}/${bytes.length}`
          })
      })
    ).rejects.toThrow()
    expect(() => statSync(mismatchFinal)).toThrow()
    expect(readFileSync(mismatchPart)).toEqual(partial)
  })

  it('follows a manual HTTPS redirect and keeps redirect handling manual', async () => {
    const bytes = Buffer.from('redirect-success-fixture')
    const asset = tinyAsset(bytes)
    const cacheRoot = join(tmpRoot, 'cache')
    const finalFile = cachePathForAsset(cacheRoot, asset)
    const redirectModes: string[] = []
    let calls = 0
    await downloadAsset({
      asset,
      cacheRoot,
      fetchImpl: async (_url: string, init?: RequestInit) => {
        redirectModes.push(init?.redirect ?? '')
        calls++
        return calls === 1
          ? new Response(null, {
              status: 302,
              headers: { Location: 'https://cdn.fixture.invalid/model' }
            })
          : response(bytes, 200)
      }
    })
    expect(calls).toBe(2)
    expect(redirectModes).toEqual(['manual', 'manual'])
    expect(readFileSync(finalFile)).toEqual(bytes)
  })

  it('rejects a redirect to a non-HTTPS location', async () => {
    const bytes = Buffer.from('http-redirect-fixture')
    const asset = tinyAsset(bytes)
    const cacheRoot = join(tmpRoot, 'cache')
    const finalFile = cachePathForAsset(cacheRoot, asset)
    await expect(
      downloadAsset({
        asset,
        cacheRoot,
        fetchImpl: async () =>
          new Response(null, {
            status: 302,
            headers: { Location: 'http://cdn.fixture.invalid/model' }
          })
      })
    ).rejects.toThrow()
    expect(() => statSync(finalFile)).toThrow()
  })

  it('enforces maxRedirects', async () => {
    const asset = tinyAsset(Buffer.from('too-many-redirects-fixture'))
    let calls = 0
    await expect(
      downloadAsset({
        asset,
        cacheRoot: join(tmpRoot, 'cache'),
        maxRedirects: 2,
        fetchImpl: async () => {
          calls++
          return new Response(null, {
            status: 302,
            headers: { Location: `https://cdn.fixture.invalid/redirect-${calls}` }
          })
        }
      })
    ).rejects.toThrow()
    expect(calls).toBe(3)
  })

  it('rejects 416 for a smaller partial and preserves that partial', async () => {
    const bytes = Buffer.from('range-not-satisfiable-fixture')
    const asset = tinyAsset(bytes)
    const cacheRoot = join(tmpRoot, 'cache')
    const finalFile = cachePathForAsset(cacheRoot, asset)
    const partFile = `${finalFile}.part`
    const partial = bytes.subarray(0, 10)
    writeTiny(cacheRoot, relative(cacheRoot, partFile), partial)
    await expect(
      downloadAsset({
        asset,
        cacheRoot,
        fetchImpl: async () => new Response(null, { status: 416 })
      })
    ).rejects.toThrow()
    expect(readFileSync(partFile)).toEqual(partial)
    expect(() => statSync(finalFile)).toThrow()
  })

  it('removes a same-size wrong-hash response without creating a final file', async () => {
    const bytes = Buffer.from('correct-payload-fixture-content')
    const wrongBytes = Buffer.alloc(bytes.length, 0x78)
    const asset = tinyAsset(bytes)
    const cacheRoot = join(tmpRoot, 'cache')
    const finalFile = cachePathForAsset(cacheRoot, asset)
    await expect(
      downloadAsset({
        asset,
        cacheRoot,
        fetchImpl: async () => response(wrongBytes, 200)
      })
    ).rejects.toThrow()
    expect(() => statSync(finalFile)).toThrow()
    expect(() => statSync(`${finalFile}.part`)).toThrow()
  })

  it('fetches selected assets by default and all candidates only when explicit', async () => {
    const fixture = makeTinyFixture()
    const candidateBytes = Buffer.from('tiny-candidate-weights')
    const candidate = fixture.catalog.assets.find((asset: any) => asset.id === 'candidate-text-weights')
    candidate.source.bytes = candidateBytes.length
    candidate.source.sha256 = sha256(candidateBytes)
    validateCatalog(fixture.catalog)
    const contents: Record<string, Buffer> = {
      'text-weights': fixture.contents.text,
      'vision-weights': fixture.contents.vision,
      'candidate-text-weights': candidateBytes
    }
    const injectedFetch = (requested: string[]) => async (url: string) => {
      const asset = fixture.catalog.assets.find((entry: any) => url.includes(entry.source.path))
      requested.push(asset.id)
      return response(contents[asset.id], 200)
    }

    const selectedRequests: string[] = []
    await fetchLocalAi({
      catalog: fixture.catalog,
      cacheRoot: join(tmpRoot, 'selected-cache'),
      fetchImpl: injectedFetch(selectedRequests)
    })
    expect(selectedRequests.sort()).toEqual(['text-weights', 'vision-weights'])

    const allRequests: string[] = []
    await fetchLocalAi({
      catalog: fixture.catalog,
      cacheRoot: join(tmpRoot, 'all-cache'),
      fetchImpl: injectedFetch(allRequests),
      allCandidates: true
    })
    expect(allRequests.sort()).toEqual(['candidate-text-weights', 'text-weights', 'vision-weights'])
  })
})
