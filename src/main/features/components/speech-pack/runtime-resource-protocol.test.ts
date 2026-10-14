import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeFeatureLease, VerifiedRuntimeResourcePin } from './runtime-lease'
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

function runtimeLease(path: string, bytes: Uint8Array): RuntimeFeatureLease {
  const pin: VerifiedRuntimeResourcePin = {
    path,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
  return {
    feature: 'offline-asr',
    generationIdentity: 'test-generation',
    catalogIdentity: 'test-catalog',
    target: {
      packageProfileIdentity: null,
      packagePlatform: null,
      packageArch: null,
      runningPlatform: process.platform,
      runningArch: process.arch,
      appVersion: 'test',
      electronVersion: undefined,
      nodeAbi: undefined,
      napiVersion: undefined,
      chromiumVersion: undefined
    },
    verifyCurrentBytes: async () => undefined,
    preparePhysicalAdmission: async () => ({ assertCurrentSync: () => undefined, dispose: async () => undefined }),
    loaderDirectories: () => [],
    entry: () => path,
    model: () => path,
    modelFile: () => path,
    rendererFile: () => path,
    rendererRolePath: () => path,
    rendererModelRoot: () => path,
    rendererResource: () => pin,
    rendererResources: () => new Map([['runtime/worker.bin', path]]),
    release: async () => undefined
  }
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
      lease: runtimeLease(path, bytes),
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
    let authorityChecks = 0
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
      lease: runtimeLease(path, bytes),
      hostAssets: {},
      assertCurrent: async () => {
        authorityChecks += 1
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
    const firstRevoke = protocol.revoke()
    const secondRevoke = protocol.revoke()
    expect(secondRevoke).toBe(firstRevoke)
    const revocation = firstRevoke.then(() => {
      revoked = true
    })
    await Promise.resolve()
    expect(revoked).toBe(false)
    releaseRead()
    await revocation
    expect(revoked).toBe(true)
    const checksAfterRevoke = authorityChecks
    const inactive = await protocol.handle(new Request(`metis-runtime://${TOKEN}/runtime/runtime/worker.bin`))
    expect(inactive.status).toBe(404)
    expect(inactive.headers.get('Cache-Control')).toBe('no-store')
    expect(authorityChecks).toBe(checksAfterRevoke)
  })

  it('keeps the active stream ceiling at eight and returns capacity 429', async () => {
    const bytes = Buffer.alloc(64 * 1024 + 1, 7)
    const path = await resourceFile(bytes)
    const protocol = createRuntimeResourceProtocol({
      token: TOKEN,
      lease: runtimeLease(path, bytes),
      hostAssets: {},
      assertCurrent: async () => undefined
    })

    const activeResponses: Response[] = []
    for (let index = 0; index < 8; index += 1) {
      const response = await protocol.handle(new Request(`metis-runtime://${TOKEN}/runtime/runtime/worker.bin`))
      expect(response.status).toBe(200)
      activeResponses.push(response)
    }
    const overflow = await protocol.handle(new Request(`metis-runtime://${TOKEN}/runtime/runtime/worker.bin`))
    expect(overflow.status).toBe(429)
    expect(overflow.headers.get('Cache-Control')).toBe('no-store')

    // arrayBuffer() resolves only after the first admitted stream reads its pinned body to EOF,
    // which removes it from the protocol's live-stream set and restores one active slot.
    expect((await activeResponses[0]!.arrayBuffer()).byteLength).toBe(bytes.byteLength)
    const replacement = await protocol.handle(new Request(`metis-runtime://${TOKEN}/runtime/runtime/worker.bin`))
    expect(replacement.status).toBe(200)
    activeResponses.push(replacement)
    await protocol.revoke()
  })
})
