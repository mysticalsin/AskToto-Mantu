import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createPackageRuntimeContractProvider,
  readPackageRuntimeContract,
  type PackageInventoryV1
} from './package-contract'

const roots: string[] = []

async function fixture(profile: 'full' | 'lean' = 'lean'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'metis-package-contract-'))
  roots.push(root)
  const profileBytes = Buffer.from(JSON.stringify({ schema: 1, profile }) + '\n')
  await writeFile(join(root, 'speech-pack-profile.json'), profileBytes)
  const coreFiles = [
    {
      path: 'speech-pack-profile.json',
      bytes: profileBytes.byteLength,
      sha256: createHash('sha256').update(profileBytes).digest('hex')
    }
  ]
  const payload = {
    schema: 1 as const,
    profile,
    platform: 'darwin' as const,
    arch: 'arm64' as const,
    appVersion: '2.1.0',
    electronVersion: '43.6.0',
    sourceCommit: 'a'.repeat(40),
    coreFiles
  }
  const identity = createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex')
  const inventory: PackageInventoryV1 = { ...payload, identity }
  await writeFile(join(root, 'package-inventory.json'), JSON.stringify(inventory) + '\n')
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('readPackageRuntimeContract', () => {
  it('preserves the legacy full-package path when both package resources are absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metis-package-contract-'))
    roots.push(root)
    await expect(
      readPackageRuntimeContract({
        resourcesRoot: root,
        compiledProfile: 'full',
        appVersion: '2.1.0',
        platform: 'darwin',
        arch: 'arm64',
        electronVersion: '43.6.0'
      })
    ).resolves.toMatchObject({ status: 'legacy-full', profile: 'full' })
  })

  it('requires a matching profile and inventory for lean packages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metis-package-contract-'))
    roots.push(root)
    await expect(
      readPackageRuntimeContract({
        resourcesRoot: root,
        compiledProfile: 'lean',
        appVersion: '2.1.0',
        platform: 'darwin',
        arch: 'arm64',
        electronVersion: '43.6.0'
      })
    ).resolves.toMatchObject({ status: 'invalid' })
  })

  it('accepts only the inventory matching the compiled profile and exact runtime target', async () => {
    const root = await fixture()
    const options = {
      resourcesRoot: root,
      compiledProfile: 'lean' as const,
      appVersion: '2.1.0',
      platform: 'darwin',
      arch: 'arm64',
      electronVersion: '43.6.0'
    }
    await expect(readPackageRuntimeContract(options)).resolves.toMatchObject({ status: 'verified', profile: 'lean' })
    await expect(readPackageRuntimeContract({ ...options, compiledProfile: 'full' })).resolves.toMatchObject({
      status: 'invalid',
      reason: 'profile-mismatch'
    })
    await expect(readPackageRuntimeContract({ ...options, arch: 'x64' })).resolves.toMatchObject({
      status: 'invalid',
      reason: 'target-mismatch'
    })
    await expect(readPackageRuntimeContract({ ...options, electronVersion: '42.0.0' })).resolves.toMatchObject({
      status: 'invalid',
      reason: 'inventory-invalid'
    })
  })

  it('rejects inventory identity drift and universal lean inventories', async () => {
    const root = await fixture()
    const path = join(root, 'package-inventory.json')
    const inventory = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    inventory.identity = '0'.repeat(64)
    await writeFile(path, JSON.stringify(inventory))
    await expect(
      readPackageRuntimeContract({
        resourcesRoot: root,
        compiledProfile: 'lean',
        appVersion: '2.1.0',
        platform: 'darwin',
        arch: 'arm64',
        electronVersion: '43.6.0'
      })
    ).resolves.toMatchObject({ status: 'invalid', reason: 'inventory-invalid' })

    const universalPayload = {
      schema: 1,
      profile: 'lean',
      platform: 'darwin',
      arch: 'universal',
      appVersion: '2.1.0',
      electronVersion: '43.6.0',
      sourceCommit: 'a'.repeat(40),
      coreFiles: [
        {
          path: 'speech-pack-profile.json',
          bytes: Buffer.byteLength(JSON.stringify({ schema: 1, profile: 'lean' }) + '\n'),
          sha256: createHash('sha256')
            .update(JSON.stringify({ schema: 1, profile: 'lean' }) + '\n')
            .digest('hex')
        }
      ]
    }
    const universal = {
      ...universalPayload,
      identity: createHash('sha256').update(JSON.stringify(universalPayload), 'utf8').digest('hex')
    }
    await writeFile(path, JSON.stringify(universal))
    await expect(
      readPackageRuntimeContract({
        resourcesRoot: root,
        compiledProfile: 'lean',
        appVersion: '2.1.0',
        platform: 'darwin',
        arch: 'arm64',
        electronVersion: '43.6.0'
      })
    ).resolves.toMatchObject({ status: 'invalid', reason: 'target-mismatch' })
  })

  it('loads startup package facts once and reuses the immutable result', async () => {
    const root = await fixture()
    const provider = createPackageRuntimeContractProvider({
      resourcesRoot: root,
      compiledProfile: 'lean',
      appVersion: '2.1.0',
      platform: 'darwin',
      arch: 'arm64',
      electronVersion: '43.6.0'
    })
    const first = await provider()
    await writeFile(join(root, 'package-inventory.json'), '{}')
    const second = await provider()
    expect(first.status).toBe('verified')
    expect(second).toBe(first)
  })

  it('rejects a profile marker whose bytes do not match the package inventory', async () => {
    const root = await fixture()
    await writeFile(join(root, 'speech-pack-profile.json'), JSON.stringify({ schema: 1, profile: 'lean' }))
    await expect(
      readPackageRuntimeContract({
        resourcesRoot: root,
        compiledProfile: 'lean',
        appVersion: '2.1.0',
        platform: 'darwin',
        arch: 'arm64',
        electronVersion: '43.6.0'
      })
    ).resolves.toMatchObject({ status: 'invalid', reason: 'inventory-invalid' })
  })
})
