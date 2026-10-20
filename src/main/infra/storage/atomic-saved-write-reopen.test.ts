import { mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { atomicSavedWriteStream } from './atomic-saved-write'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, open: vi.fn(original.open) }
})

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('refuses a temp path replaced while its owned content handle is being read', async () => {
  const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'metis-stream-reread-'))
  roots.push(root)
  const target = join(root, 'meeting.md')
  const held = join(root, 'original-owned-temp')
  await writeFile(target, 'old')
  let replacedPath: string | undefined
  let rereads = 0
  vi.mocked(open).mockImplementation(async (path, flags, mode) => {
    const handle = await original.open(path, flags, mode)
    if (flags === 'wx') return handle
    if (++rereads !== 2) return handle
    // Replace the path at EOF of the final reread, after async pre-replace admission.
    return new Proxy(handle, {
      get(object, key) {
        if (key === 'read') {
          return async (...args: unknown[]) => {
            const result = await Reflect.apply(object.read, object, args)
            if (result.bytesRead === 0 && !replacedPath) {
              replacedPath = String(path)
              await rename(replacedPath, held)
              await writeFile(replacedPath, 'bad')
            }
            return result
          }
        }
        const value = Reflect.get(object, key, object)
        return typeof value === 'function' ? value.bind(object) : value
      }
    })
  })

  async function* chunks(): AsyncGenerator<Uint8Array> {
    yield Uint8Array.from(Buffer.from('new'))
  }

  await expect(
    atomicSavedWriteStream(target, chunks(), { maxBytes: 16, maxChunkBytes: 8, maxChunks: 4 })
  ).rejects.toMatchObject({ name: 'TEMP_OWNERSHIP' })
  expect(replacedPath).toBeDefined()
  expect(await readFile(target, 'utf8')).toBe('old')
  expect(await readFile(replacedPath!, 'utf8')).toBe('bad')
  expect(await readFile(held, 'utf8')).toBe('new')
})
