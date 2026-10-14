import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeInventoryV1 } from './runtime-provenance'
import { verifyStagedPayloads } from './runtime-staged-verifier'

const roots: string[] = []

async function stagedFixture(): Promise<{ stage: string; inventory: RuntimeInventoryV1; firstPath: string }> {
  const stage = await mkdtemp(join(tmpdir(), 'runtime-staged-verifier-'))
  roots.push(stage)
  const root = join(stage, 'artifacts', 'runtime-native')
  await mkdir(root, { recursive: true })
  const first = Buffer.from('signed-first-entry')
  const second = Buffer.from('signed-later-entry')
  const firstPath = join(root, 'a-native.bin')
  await writeFile(firstPath, first, { mode: 0o600 })
  await writeFile(join(root, 'z-model.bin'), second, { mode: 0o600 })
  return {
    stage,
    firstPath,
    inventory: {
      schemaVersion: 1,
      kind: 'runtime',
      componentId: 'runtime',
      artifactId: 'runtime-native',
      target: { platform: 'any', arch: 'any' },
      runtime: null,
      source: {} as RuntimeInventoryV1['source'],
      builder: {} as RuntimeInventoryV1['builder'],
      upstream: [],
      files: [first, second].map((bytes, index) => ({
        path: index === 0 ? 'a-native.bin' : 'z-model.bin',
        bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        executable: false
      })),
      licenses: []
    } as unknown as RuntimeInventoryV1
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('staged runtime physical version closure', () => {
  it('rejects an earlier native entry changed while a later model is being verified', async () => {
    const fixture = await stagedFixture()
    let checks = 0
    await expect(
      verifyStagedPayloads(fixture.stage, [fixture.inventory], async () => {
        checks++
        if (checks === 2) await writeFile(fixture.firstPath, 'changed-native-entry', { mode: 0o600 })
      })
    ).rejects.toThrow('RUNTIME_STAGED_FILE_PIN_MISMATCH')
  })

  it('accepts the unchanged complete staged closure', async () => {
    const fixture = await stagedFixture()
    const admission = await verifyStagedPayloads(fixture.stage, [fixture.inventory], async () => undefined)
    try {
      expect(admission).toBeDefined()
      admission.assertCurrentSync()
    } finally {
      await admission.dispose()
    }
  })

  it('rejects an extra staged member added during the final retained-version checks', async () => {
    const fixture = await stagedFixture()
    let checks = 0
    await expect(
      verifyStagedPayloads(fixture.stage, [fixture.inventory], async () => {
        checks++
        if (checks === 5) {
          await writeFile(join(fixture.stage, 'artifacts', 'runtime-native', 'unsigned-extra.bin'), 'extra', {
            mode: 0o600
          })
        }
      })
    ).rejects.toThrow('RUNTIME_STAGED_FILE_CLOSURE_MISMATCH')
  })
})
