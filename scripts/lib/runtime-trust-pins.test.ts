import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { assertRuntimeTrustPins } from './runtime-trust-pins.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const roots = new Set<string>()

async function stagedFixture() {
  const root = await mkdtemp(join(tmpdir(), 'metis-runtime-trust-'))
  roots.add(root)
  const resources = join(root, 'resources')
  const trust = join(resources, 'runtime-trust')
  await mkdir(trust, { recursive: true })
  await copyFile(join(REPO_ROOT, 'resources/runtime-catalog.json'), join(resources, 'runtime-catalog.json'))
  await copyFile(
    join(REPO_ROOT, 'resources/runtime-trust/sigstore-trusted-root.json'),
    join(trust, 'sigstore-trusted-root.json')
  )
  await copyFile(
    join(REPO_ROOT, 'resources/runtime-trust/acquisition-receipt.json'),
    join(trust, 'acquisition-receipt.json')
  )
  return { root, resources }
}

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

describe('app-owned runtime trust pins', () => {
  it('accepts the exact catalog, root and acquisition receipt staged for packaging', async () => {
    const { resources } = await stagedFixture()
    const verified = await assertRuntimeTrustPins(resources)
    expect(verified.rootBytes.byteLength).toBe(6787)
    expect(verified.receiptBytes.byteLength).toBe(663)
    expect(verified.catalog.targets).toEqual([])
  })

  it('rejects changed root bytes even when the catalog remains unchanged', async () => {
    const { resources } = await stagedFixture()
    const path = join(resources, 'runtime-trust/sigstore-trusted-root.json')
    const bytes = await readFile(path)
    bytes[0] ^= 1
    await writeFile(path, bytes)
    await expect(assertRuntimeTrustPins(resources)).rejects.toThrow('RUNTIME_TRUST_ROOT_PIN_MISMATCH')
  })

  it('rejects a missing receipt file', async () => {
    const { resources } = await stagedFixture()
    await rm(join(resources, 'runtime-trust/acquisition-receipt.json'))
    await expect(assertRuntimeTrustPins(resources)).rejects.toThrow('RUNTIME_TRUST_RECEIPT_PIN_MISMATCH')
  })

  it('rejects any enabled target until actual runtime publication is reviewed', async () => {
    const { resources } = await stagedFixture()
    const path = join(resources, 'runtime-catalog.json')
    const catalog = JSON.parse(await readFile(path, 'utf8'))
    catalog.targets.push({ componentId: 'unreviewed' })
    await writeFile(path, `${JSON.stringify(catalog)}\n`)
    await expect(assertRuntimeTrustPins(resources)).rejects.toThrow('RUNTIME_CATALOG_INVALID')
  })
})
