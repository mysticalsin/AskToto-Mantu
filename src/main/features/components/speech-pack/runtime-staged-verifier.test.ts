import { createHash } from 'node:crypto'
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeInventoryV1 } from './runtime-provenance'
import { verifyStagedPayloads } from './runtime-staged-verifier'

const roots: string[] = []

async function stagedFixture(): Promise<{
  stage: string
  rawStage: string
  artifactRoot: string
  inventory: RuntimeInventoryV1
  firstPath: string
  secondPath: string
}> {
  const rawStage = await mkdtemp(join(tmpdir(), 'runtime-staged-verifier-'))
  roots.push(rawStage)
  const created = await lstat(rawStage, { bigint: true })
  const stage = await realpath(rawStage)
  const canonical = await stat(stage, { bigint: true })
  if (created.dev !== canonical.dev || created.ino !== canonical.ino || created.birthtimeNs !== canonical.birthtimeNs) {
    throw new Error('test-owned staged directory identity changed while canonicalizing')
  }
  const root = join(stage, 'artifacts', 'runtime-native')
  await mkdir(root, { recursive: true })
  const first = Buffer.from('signed-first-entry')
  const second = Buffer.from('signed-later-entry')
  const firstPath = join(root, 'a-native.bin')
  const secondPath = join(root, 'z-model.bin')
  await writeFile(firstPath, first, { mode: 0o600 })
  await writeFile(secondPath, second, { mode: 0o600 })
  return {
    stage,
    rawStage,
    artifactRoot: root,
    firstPath,
    secondPath,
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
    expect(await realpath(fixture.rawStage)).toBe(fixture.stage)
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
    const extra = join(fixture.artifactRoot, 'unsigned-extra.bin')
    await expect(
      verifyStagedPayloads(fixture.stage, [fixture.inventory], async () => {
        checks++
        if (checks === 5) {
          await writeFile(extra, 'extra', { mode: 0o600 })
        }
      })
    ).rejects.toThrow('RUNTIME_PHYSICAL_NODE_CHANGED')
    expect(checks).toBe(5)
    expect(await readFile(fixture.firstPath)).toEqual(Buffer.from('signed-first-entry'))
    expect(await readFile(fixture.secondPath)).toEqual(Buffer.from('signed-later-entry'))
    expect(await readFile(extra)).toEqual(Buffer.from('extra'))
  })

  it('rejects an inserted directory member at the retained-membership check', async () => {
    const fixture = await stagedFixture()
    let checks = 0
    const extra = join(fixture.artifactRoot, 'unsigned-extra.bin')
    await expect(
      verifyStagedPayloads(fixture.stage, [fixture.inventory], async () => {
        checks += 1
        // Two file checks and the stage-directory pass precede this first artifact-directory check.
        if (checks === 4) await writeFile(extra, 'extra', { mode: 0o600 })
      })
    ).rejects.toThrow('RUNTIME_STAGED_FILE_CLOSURE_MISMATCH')
    expect(checks).toBe(4)
    expect(await readFile(fixture.firstPath)).toEqual(Buffer.from('signed-first-entry'))
    expect(await readFile(fixture.secondPath)).toEqual(Buffer.from('signed-later-entry'))
  })

  it('rejects a linked alias for the test-owned canonical staged root', async () => {
    const fixture = await stagedFixture()
    const aliasParent = `${fixture.rawStage}-parent-alias`
    roots.push(aliasParent)
    await symlink(dirname(fixture.stage), aliasParent, process.platform === 'win32' ? 'junction' : 'dir')
    const alias = join(aliasParent, basename(fixture.stage))
    const admission = await verifyStagedPayloads(alias, [fixture.inventory], async () => undefined)
    try {
      expect(() => admission.assertCurrentSync()).toThrow('RUNTIME_INSTALL_ACTIVE_ROOT_CHANGED')
    } finally {
      await admission.dispose()
    }
  })
})
