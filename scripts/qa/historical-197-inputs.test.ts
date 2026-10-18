import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  hashHistorical197File,
  validateHistorical197Metadata,
  verifyHistorical197Inputs
} from './historical-197-inputs.mjs'

// Exact public original provenance, verified against the published asset digest; no invented build.version.
const ORIGINAL_PROVENANCE = `{
  "schema": 2,
  "repository": "mysticalsin/AskToto-Mantu",
  "commit": "98461f85dcca49a2ded3f1489daed10d194f5229",
  "version": "1.9.7",
  "run": {
    "id": 38795048288,
    "attempt": 1,
    "url": "https://github.com/mysticalsin/AskToto-Mantu/actions/runs/38795048288"
  },
  "builds": [
    {
      "variant": "mac",
      "artifact": "candidate-mac",
      "platform": "mac",
      "runner": {
        "os": "macOS",
        "arch": "ARM64",
        "image": "macos26",
        "image_version": "20260907.0351.1"
      },
      "node": "v22.22.3",
      "electron": "43.6.0",
      "electron_builder": "26.15.3",
      "builder_config": [
        {
          "path": "electron-builder.yml",
          "sha256": "ec8afce51d3971f7138f24a8c27775b1a799a77b73a9bfdb6c91bb30d71f577a"
        }
      ],
      "signing": {
        "mode": "ad-hoc"
      },
      "assets": [
        {
          "name": "Metis-1.9.7.dmg",
          "size": 1827516056,
          "sha256": "3ff51e9d50eb1413361c7be68ab542361bae5dad63fa22031e08b5be7bc5a304"
        },
        {
          "name": "Metis-1.9.7.zip",
          "size": 1826734829,
          "sha256": "6fbf0b72fba0e2f70ee53adf2f7e73224d2deab432a79afc2ed1874396cb8edc"
        }
      ]
    },
    {
      "variant": "mac-qa-identity",
      "artifact": "candidate-mac-qa-identity",
      "platform": "mac",
      "runner": {
        "os": "macOS",
        "arch": "ARM64",
        "image": "macos26",
        "image_version": "20260907.0351.1"
      },
      "node": "v22.22.3",
      "electron": "43.6.0",
      "electron_builder": "26.15.3",
      "builder_config": [
        {
          "path": "build/qa-identity.electron-builder.yml",
          "sha256": "1021777aafe8093552cafd9adc54c2c26907987a6a0414ce62808888c6c17a68"
        },
        {
          "path": "electron-builder.yml",
          "sha256": "ec8afce51d3971f7138f24a8c27775b1a799a77b73a9bfdb6c91bb30d71f577a"
        }
      ],
      "signing": {
        "mode": "ad-hoc"
      },
      "assets": [
        {
          "name": "Metis-QA-1.9.7.zip",
          "size": 1826812070,
          "sha256": "3474c40abb8a8df7831746e0b345a057c4463358a509a9c1d2fdb137feaec3b2"
        }
      ]
    },
    {
      "variant": "win",
      "artifact": "candidate-win",
      "platform": "win",
      "runner": {
        "os": "Windows",
        "arch": "X64",
        "image": "win25-vs2026",
        "image_version": "20261007.264.1"
      },
      "node": "v22.22.3",
      "electron": "43.6.0",
      "electron_builder": "26.15.3",
      "builder_config": [
        {
          "path": "electron-builder.win.yml",
          "sha256": "89fab48e8807686c29bc625ddce12c8dbc0ea1e33478b7454928e24b7f6c1497"
        },
        {
          "path": "electron-builder.yml",
          "sha256": "ec8afce51d3971f7138f24a8c27775b1a799a77b73a9bfdb6c91bb30d71f577a"
        }
      ],
      "signing": {
        "mode": "unsigned"
      },
      "assets": [
        {
          "name": "Metis-Setup-1.9.7.exe",
          "size": 1533431944,
          "sha256": "40a791388df139e0cd1c01cdf33ccf1f0a530192820434a967802371de0f3416"
        }
      ]
    },
    {
      "variant": "win-portable",
      "artifact": "candidate-win-portable",
      "platform": "win",
      "runner": {
        "os": "Windows",
        "arch": "X64",
        "image": "win25-vs2026",
        "image_version": "20261007.264.1"
      },
      "node": "v22.22.3",
      "electron": "43.6.0",
      "electron_builder": "26.15.3",
      "builder_config": [
        {
          "path": "electron-builder.win.yml",
          "sha256": "89fab48e8807686c29bc625ddce12c8dbc0ea1e33478b7454928e24b7f6c1497"
        },
        {
          "path": "electron-builder.yml",
          "sha256": "ec8afce51d3971f7138f24a8c27775b1a799a77b73a9bfdb6c91bb30d71f577a"
        }
      ],
      "signing": {
        "mode": "unsigned"
      },
      "assets": [
        {
          "name": "Metis-Portable-1.9.7.exe",
          "size": 1523718610,
          "sha256": "0807ed3c53b261318d4582b3e8447b120c43fceb56dc911911d3128da09bbfe9"
        }
      ]
    }
  ]
}
`
const ORIGINAL_SUMS = `3ff51e9d50eb1413361c7be68ab542361bae5dad63fa22031e08b5be7bc5a304  Metis-1.9.7.dmg
6fbf0b72fba0e2f70ee53adf2f7e73224d2deab432a79afc2ed1874396cb8edc  Metis-1.9.7.zip
40a791388df139e0cd1c01cdf33ccf1f0a530192820434a967802371de0f3416  Metis-Setup-1.9.7.exe
`
const SOURCE = '98461f85dcca49a2ded3f1489daed10d194f5229'
const HARNESS = '16db3db5715b7f7f6a9ba6658bfaae97d111f3fa'
const REPOSITORY = { id: 1282463398, full_name: 'mysticalsin/AskToto-Mantu' }
const PUBLIC_ASSETS = [
  { id: 645178383, name: 'Metis-1.9.7.dmg', size: 1827516056, digest: 'sha256:3ff51e9d50eb1413361c7be68ab542361bae5dad63fa22031e08b5be7bc5a304' },
  { id: 645180903, name: 'Metis-1.9.7.zip', size: 1826734829, digest: 'sha256:6fbf0b72fba0e2f70ee53adf2f7e73224d2deab432a79afc2ed1874396cb8edc' },
  { id: 645183715, name: 'Metis-Setup-1.9.7.exe', size: 1533431944, digest: 'sha256:40a791388df139e0cd1c01cdf33ccf1f0a530192820434a967802371de0f3416' },
  { id: 645185922, name: 'provenance.json', size: 4106, digest: 'sha256:d3a6872da5e1b3fb3aed651d860c399265d20edaa88fb27cc4d3ffd18a092104' },
  { id: 645185936, name: 'SHA256SUMS.txt', size: 252, digest: 'sha256:39aec8ab23e19d6f0e5d240a86072c2b904caed651296d6e8d2a4d863802ddc3' }
]

function context() {
  return {
    repository: { ...REPOSITORY },
    harnessCommit: HARNESS,
    candidateRun: {
      id: 38795048288, run_attempt: 1, path: '.github/workflows/qa-candidate.yml',
      event: 'workflow_dispatch', head_branch: 'main', head_sha: SOURCE,
      status: 'completed', conclusion: 'success',
      repository: { ...REPOSITORY }, head_repository: { ...REPOSITORY }
    },
    release: {
      id: 414278048, tag_name: 'metis-unsigned-v1.9.7',
      name: 'Métis 1.9.7 (unsigned, manual install)', target_commitish: SOURCE,
      draft: false, prerelease: true, assets: PUBLIC_ASSETS.map(asset => ({ ...asset }))
    }
  }
}

const validate = (metadata = context(), provenance = ORIGINAL_PROVENANCE, sums = ORIGINAL_SUMS) =>
  validateHistorical197Metadata(metadata, Buffer.from(provenance), Buffer.from(sums))

describe('historical 1.9.7 immutable public input identity', () => {
  it('accepts the actual schema-2 top-level version and retains all four original build declarations', () => {
    expect(Buffer.byteLength(ORIGINAL_PROVENANCE)).toBe(4106)
    expect(createHash('sha256').update(ORIGINAL_PROVENANCE).digest('hex')).toBe('d3a6872da5e1b3fb3aed651d860c399265d20edaa88fb27cc4d3ffd18a092104')
    expect(Buffer.byteLength(ORIGINAL_SUMS)).toBe(252)
    expect(createHash('sha256').update(ORIGINAL_SUMS).digest('hex')).toBe('39aec8ab23e19d6f0e5d240a86072c2b904caed651296d6e8d2a4d863802ddc3')
    const original = JSON.parse(ORIGINAL_PROVENANCE)
    expect(original.builds.map((build: { variant: string }) => build.variant)).toEqual(['mac', 'mac-qa-identity', 'win', 'win-portable'])
    expect(original.builds.every((build: object) => !Object.hasOwn(build, 'version'))).toBe(true)
    const receipt = validate()
    expect(receipt).toMatchObject({
      scope: 'IDENTITY_ONLY', outcome: 'VERIFIED', verification: 'metadata-only',
      artifact_source: SOURCE, harness_commit: HARNESS, candidate_run: 38795048288,
      candidate_attempt: 1, release_id: 414278048, tag: 'metis-unsigned-v1.9.7'
    })
    expect(receipt.assets.map((asset: { name: string }) => asset.name)).toEqual(PUBLIC_ASSETS.map(asset => asset.name))
    expect(JSON.stringify(receipt)).not.toContain('Metis-QA')
    expect(JSON.stringify(receipt)).not.toContain('Metis-Portable')
    const regularRelease = context()
    regularRelease.release.prerelease = false
    expect(validate(regularRelease).outcome).toBe('VERIFIED')
  })

  it.each<[string, (metadata: ReturnType<typeof context>) => void]>([
    ['repository', value => { value.repository.id += 1 }],
    ['head repository', value => { value.candidateRun.head_repository.full_name = 'other/repository' }],
    ['run repository', value => { value.candidateRun.repository.id += 1 }],
    ['run ID', value => { value.candidateRun.id += 1 }],
    ['attempt', value => { value.candidateRun.run_attempt = 2 }],
    ['workflow', value => { value.candidateRun.path = '.github/workflows/build.yml' }],
    ['event', value => { value.candidateRun.event = 'pull_request' }],
    ['ref', value => { value.candidateRun.head_branch = 'release/1.9.x' }],
    ['artifact source', value => { value.candidateRun.head_sha = HARNESS }],
    ['status', value => { value.candidateRun.status = 'in_progress' }],
    ['conclusion', value => { value.candidateRun.conclusion = 'failure' }],
    ['harness SHA', value => { value.harnessCommit = 'private-path-canary' }],
    ['release ID', value => { value.release.id += 1 }],
    ['release tag', value => { value.release.tag_name = 'v1.9.7' }],
    ['release source alias', value => { value.release.target_commitish = 'main' }],
    ['draft', value => { value.release.draft = true }],
    ['asset ID', value => { value.release.assets[0].id += 1 }],
    ['asset name', value => { value.release.assets[0].name = '../private-path-canary' }],
    ['asset bytes', value => { value.release.assets[0].size -= 1 }],
    ['asset digest', value => { value.release.assets[0].digest = 'sha256:' + '0'.repeat(64) }],
    ['missing asset', value => { value.release.assets.pop() }],
    ['extra asset', value => { value.release.assets.push({ ...value.release.assets[0], id: 1 }) }],
    ['duplicate asset', value => { value.release.assets[1] = { ...value.release.assets[0] } }]
  ])('refuses changed %s without exposing the supplied value', (_name, mutate) => {
    const metadata = context()
    mutate(metadata)
    expect(validate(metadata)).toMatchObject({ scope: 'IDENTITY_ONLY', outcome: 'REFUSED', code: 'context-mismatch' })
    expect(JSON.stringify(validate(metadata))).not.toContain('private-path-canary')
  })

  it.each([
    ['schema', (value: any) => { value.schema = 1 }],
    ['top-level version', (value: any) => { value.version = '1.9.8' }],
    ['build.version added', (value: any) => { value.builds[0].version = '1.9.7' }],
    ['missing QA declaration', (value: any) => { value.builds.splice(1, 1) }],
    ['extra build', (value: any) => { value.builds.push(value.builds[0]) }],
    ['configuration digest', (value: any) => { value.builds[0].builder_config[0].sha256 = '0'.repeat(64) }],
    ['runner fact', (value: any) => { value.builds[0].runner.arch = 'X64' }],
    ['signing fact', (value: any) => { value.builds[0].signing.mode = 'developer-id' }]
  ] as Array<[string, (value: any) => void]>)('refuses tampered original %s', (_name, mutate) => {
    const value = JSON.parse(ORIGINAL_PROVENANCE)
    mutate(value)
    expect(validate(context(), JSON.stringify(value, null, 2) + '\n')).toMatchObject({ outcome: 'REFUSED', code: 'provenance-mismatch' })
  })

  it('refuses non-original provenance bytes, checksum lines and missing context fields', () => {
    expect(validate(context(), ORIGINAL_PROVENANCE + '\n')).toMatchObject({ outcome: 'REFUSED', code: 'provenance-mismatch' })
    expect(validate(context(), ORIGINAL_PROVENANCE, ORIGINAL_SUMS.replace('Metis-1.9.7.zip', 'Metis-QA-1.9.7.zip'))).toMatchObject({ outcome: 'REFUSED', code: 'checksums-mismatch' })
    expect(validateHistorical197Metadata({}, Buffer.from(ORIGINAL_PROVENANCE), Buffer.from(ORIGINAL_SUMS))).toMatchObject({ outcome: 'REFUSED', code: 'context-mismatch' })
  })
})

describe('historical input file admission and streaming bytes', () => {
  let root: string | undefined
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })
  async function directory() {
    root = await mkdtemp(join(tmpdir(), 'metis-historical-197-'))
    return root
  }
  const ABC = { size: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }

  it('hashes real local bytes and refuses size/hash mismatch and missing files', async () => {
    const dir = await directory()
    const file = join(dir, 'owned.bin')
    await writeFile(file, 'abc')
    await expect(hashHistorical197File(file, ABC)).resolves.toEqual(ABC)
    await expect(hashHistorical197File(file, { ...ABC, size: 2 })).rejects.toMatchObject({ code: 'asset-bytes-mismatch' })
    await expect(hashHistorical197File(file, { ...ABC, sha256: '0'.repeat(64) })).rejects.toMatchObject({ code: 'asset-bytes-mismatch' })
    await expect(hashHistorical197File(join(dir, 'missing-private-canary'), ABC)).rejects.toMatchObject({ code: 'input-unreadable' })
  })

  it('refuses directories and a real directory symlink or Windows junction before opening data', async () => {
    const dir = await directory()
    const target = join(dir, 'target')
    await mkdir(target)
    const link = join(dir, 'link')
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(hashHistorical197File(target, ABC)).rejects.toMatchObject({ code: 'unsafe-file' })
    await expect(hashHistorical197File(link, ABC)).rejects.toMatchObject({ code: 'unsafe-file' })
    expect(await verifyHistorical197Inputs({ metadata: context(), assetDirectory: link })).toMatchObject({ outcome: 'REFUSED', code: 'unsafe-file' })
  })

  it('rejects missing, extra and tiny substituted installer sets; never fakes a five-asset positive', async () => {
    const dir = await directory()
    expect(await verifyHistorical197Inputs({ metadata: context(), assetDirectory: dir })).toMatchObject({ outcome: 'REFUSED', code: 'asset-set-mismatch' })
    for (const asset of PUBLIC_ASSETS) await writeFile(join(dir, asset.name), 'abc')
    await writeFile(join(dir, 'provenance.json'), ORIGINAL_PROVENANCE)
    await writeFile(join(dir, 'SHA256SUMS.txt'), ORIGINAL_SUMS)
    expect(await verifyHistorical197Inputs({ metadata: context(), assetDirectory: dir })).toMatchObject({ outcome: 'REFUSED', code: 'asset-bytes-mismatch' })
    await writeFile(join(dir, 'extra-private-path-canary'), 'not an asset')
    const refusal = await verifyHistorical197Inputs({ metadata: context(), assetDirectory: dir })
    expect(refusal).toMatchObject({ outcome: 'REFUSED', code: 'asset-set-mismatch' })
    expect(JSON.stringify(refusal)).not.toContain(dir)
    expect(JSON.stringify(refusal)).not.toContain('private-path-canary')
  })

  it('uses a fixed content-free CLI refusal without running any network or installer command', () => {
    const script = fileURLToPath(new URL('./historical-197-inputs.mjs', import.meta.url))
    const child = spawnSync(process.execPath, [script, '--unknown', '/private-path-canary'], { encoding: 'utf8' })
    expect(child.status).toBe(1)
    expect(child.stderr).toBe('')
    expect(JSON.parse(child.stdout)).toEqual({ scope: 'IDENTITY_ONLY', outcome: 'REFUSED', code: 'invalid-input' })
    expect(child.stdout).not.toContain('private-path-canary')
  })
})

