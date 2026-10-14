import { lstat, mkdir, mkdtemp, open, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  renameRuntimeFileAfterAdmission,
  retainRuntimeTreeIfOwnershipIsUnproven,
  settleRuntimePointerAdmissionPair
} from './runtime-owned-files'

const roots: string[] = []

async function fixture(): Promise<{ root: string; source: string; destination: string; bytes: Buffer }> {
  const root = await mkdtemp(join(tmpdir(), 'runtime-owned-files-'))
  roots.push(root)
  const source = join(root, 'pointer.tmp')
  const destination = join(root, 'pointer.json')
  const bytes = Buffer.from('pointer-value-00000000')
  await writeFile(source, bytes, { mode: 0o600 })
  return { root, source, destination, bytes }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('runtime transaction file ownership', () => {
  it('disposes a successful retained pointer when its paired preparation fails', async () => {
    const failure = new Error('RUNTIME_INSTALL_POINTER_CHANGED')
    let releaseSource!: (admission: { assertCurrentSync(): void; dispose(): Promise<void> }) => void
    let disposed = false
    const source = new Promise<{ assertCurrentSync(): void; dispose(): Promise<void> }>((resolve) => {
      releaseSource = resolve
    })
    const preparation = settleRuntimePointerAdmissionPair(source, Promise.reject(failure))

    await Promise.resolve()
    expect(disposed).toBe(false)
    releaseSource({
      assertCurrentSync: () => undefined,
      dispose: async () => {
        disposed = true
      }
    })

    await expect(preparation).rejects.toBe(failure)
    expect(disposed).toBe(true)
  })

  it('refuses same-size foreign temp bytes changed while final root admission is held', async () => {
    const value = await fixture()
    const sourceVersion = await lstat(value.source, { bigint: true })
    let enterAdmission!: () => void
    let releaseAdmission!: () => void
    const entered = new Promise<void>((resolve) => {
      enterAdmission = resolve
    })
    const released = new Promise<void>((resolve) => {
      releaseAdmission = resolve
    })
    const publication = renameRuntimeFileAfterAdmission({
      source: value.source,
      destination: value.destination,
      sourceVersion,
      sourceBytes: value.bytes,
      destinationVersion: null,
      destinationBytes: null,
      awaitAdmission: async () => {
        enterAdmission()
        await released
      },
      assertDestinationSync: () => undefined
    })
    await entered
    await unlink(value.source)
    await writeFile(value.source, Buffer.from('pointer-value-11111111'), { mode: 0o600 })
    releaseAdmission()

    await expect(publication).rejects.toThrow('RUNTIME_INSTALL_POINTER_CHANGED')
    await expect(open(value.destination, 'r')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses an equal-byte replacement inode after final admission', async () => {
    const value = await fixture()
    const held = await open(value.source, 'r')
    try {
      const sourceVersion = await held.stat({ bigint: true })
      let enterAdmission!: () => void
      let releaseAdmission!: () => void
      const entered = new Promise<void>((resolve) => {
        enterAdmission = resolve
      })
      const released = new Promise<void>((resolve) => {
        releaseAdmission = resolve
      })
      const publication = renameRuntimeFileAfterAdmission({
        source: value.source,
        destination: value.destination,
        sourceVersion,
        sourceBytes: value.bytes,
        destinationVersion: null,
        destinationBytes: null,
        awaitAdmission: async () => {
          enterAdmission()
          await released
        },
        assertDestinationSync: () => undefined
      })
      await entered
      await unlink(value.source)
      await writeFile(value.source, value.bytes, { mode: 0o600 })
      releaseAdmission()

      await expect(publication).rejects.toThrow('RUNTIME_INSTALL_POINTER_CHANGED')
      await expect(open(value.destination, 'r')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await held.close()
    }
  })

  it('preserves a foreign staging replacement instead of chmod or recursive removal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-owned-tree-'))
    roots.push(root)
    const stageRoot = join(root, 'staging')
    const stage = join(stageRoot, 'owned')
    await mkdir(stage, { recursive: true })
    await writeFile(join(stage, 'owned.bin'), 'verified')
    const rootExpected = await lstat(stageRoot, { bigint: true })
    const expected = await lstat(stage, { bigint: true })
    await rm(stage, { recursive: true })
    await mkdir(stage)
    await writeFile(join(stage, 'foreign.bin'), 'preserve')

    await expect(
      retainRuntimeTreeIfOwnershipIsUnproven({ root: stageRoot, rootExpected, path: stage, expected })
    ).rejects.toThrow('RUNTIME_INSTALL_CLEANUP_OWNER_CHANGED')
    await expect(open(join(stage, 'foreign.bin'), 'r')).resolves.toBeDefined()
  })
})
