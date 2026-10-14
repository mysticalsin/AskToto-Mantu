import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRuntimeResourceProtocol } from './runtime-resource-protocol'

const roots: string[] = []
const TOKEN = 'a'.repeat(64)

async function resourceFile(bytes: Uint8Array): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'metis-runtime-resource-test-'))
  roots.push(root)
  const path = join(root, 'worker.bin')
  await writeFile(path, bytes)
  return path
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('private runtime resource protocol', () => {
  it('serves only the exact generation pin and rejects path variants', async () => {
    const bytes = Buffer.from('pinned-worker')
    const path = await resourceFile(bytes)
    const protocol = createRuntimeResourceProtocol({
      token: TOKEN,
      lease: {
        rendererResources: () => new Map([['runtime/worker.bin', path]]),
        rendererResource: () => ({
          path,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex')
        })
      } as never,
      hostAssets: {},
      assertCurrent: async () => undefined
    })

    const response = await protocol.handle(new Request(`metis-runtime://${TOKEN}/runtime/runtime/worker.bin`))
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
    expect((await protocol.handle(new Request(`metis-runtime://${TOKEN}/runtime/%2e%2e/worker.bin`))).status).toBe(404)
    await protocol.revoke()
    expect((await protocol.handle(new Request(`metis-runtime://${TOKEN}/runtime/runtime/worker.bin`))).status).toBe(404)
  })

  it('holds revoke until an admitted descriptor verification settles', async () => {
    const bytes = Buffer.from('held-read')
    const path = await resourceFile(bytes)
    let releaseRead!: () => void
    const heldRead = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    let enteredRead!: () => void
    const readEntered = new Promise<void>((resolve) => {
      enteredRead = resolve
    })
    let first = true
    const protocol = createRuntimeResourceProtocol({
      token: TOKEN,
      lease: {
        rendererResources: () => new Map([['runtime/worker.bin', path]]),
        rendererResource: () => ({
          path,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex')
        })
      } as never,
      hostAssets: {},
      assertCurrent: async () => {
        if (first) {
          first = false
          enteredRead()
          await heldRead
        }
      }
    })

    await protocol.handle(new Request(`metis-runtime://${TOKEN}/runtime/runtime/worker.bin`))
    await readEntered
    let revoked = false
    const revocation = protocol.revoke().then(() => {
      revoked = true
    })
    await Promise.resolve()
    expect(revoked).toBe(false)
    releaseRead()
    await revocation
    expect(revoked).toBe(true)
  })
})
