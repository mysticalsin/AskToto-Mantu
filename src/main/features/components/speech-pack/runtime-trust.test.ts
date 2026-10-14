import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseRuntimeCatalog } from './runtime-provenance'
import { createRuntimeGenerationProvider } from './runtime-generation-provider'
import { verifyPinnedRuntimeTrust } from './runtime-trust'

const resourcesRoot = join(__dirname, '..', '..', '..', '..', '..', 'resources')

describe('pinned runtime trust material', () => {
  const catalog = parseRuntimeCatalog(readFileSync(join(resourcesRoot, 'runtime-catalog.json')))
  const root = readFileSync(join(resourcesRoot, 'runtime-trust', 'sigstore-trusted-root.json'))
  const receipt = readFileSync(join(resourcesRoot, 'runtime-trust', 'acquisition-receipt.json'))

  it('accepts the packaged TUF root and acquisition receipt pins', () => {
    expect(catalog.trustRoot).not.toBeNull()
    expect(verifyPinnedRuntimeTrust(catalog.trustRoot!, root, receipt)).toEqual(
      expect.objectContaining({ mediaType: 'application/vnd.dev.sigstore.trustedroot+json;version=0.1' })
    )
  })

  it('rejects changes to either pinned trust file', () => {
    expect(() => verifyPinnedRuntimeTrust(catalog.trustRoot!, Buffer.from(root).fill(0, 0, 1), receipt)).toThrow(
      'RUNTIME_TRUST_ROOT_PIN_MISMATCH'
    )
    expect(() => verifyPinnedRuntimeTrust(catalog.trustRoot!, root, Buffer.from(receipt).fill(0, 0, 1))).toThrow(
      'RUNTIME_TRUST_ROOT_RECEIPT_PIN_MISMATCH'
    )
  })

  it('keeps runtime acquisition unavailable while the reviewed catalog has no promoted targets', async () => {
    const provider = createRuntimeGenerationProvider({
      resourcesRoot,
      storeRoot: join(resourcesRoot, 'unused-runtime-store')
    })
    await expect(provider.initialize()).resolves.toBeUndefined()
    await expect(
      provider.acquire({
        feature: 'speaker-embedding',
        target: {
          packageProfileIdentity: null,
          packagePlatform: null,
          packageArch: null,
          runningPlatform: process.platform,
          runningArch: process.arch,
          appVersion: null,
          electronVersion: process.versions.electron,
          nodeAbi: process.versions.modules,
          napiVersion: process.versions.napi,
          chromiumVersion: process.versions.chrome
        }
      })
    ).resolves.toBeNull()
  })
})
