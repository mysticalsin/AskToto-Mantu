import { describe, expect, it, vi } from 'vitest'
import { classifyAll } from './meetings-storage'
import type { FileClass, StorageGateway } from './gateway'

const CLASSIFY_BATCH = 1_000
const VERSION = { mtimeMs: 1, ctimeMs: 1, size: 1 }

const ok = (): FileClass => ({ status: 'ok', version: VERSION })
const unknown = (): FileClass => ({ status: 'unknown', version: VERSION })
const missing = (): FileClass => ({ status: 'missing' })

function classMap(relPaths: readonly string[], classify: (relPath: string) => FileClass): Map<string, FileClass> {
  return new Map(relPaths.map((relPath): [string, FileClass] => [relPath, classify(relPath)]))
}

function fakeGateway(classify: StorageGateway['classify']): StorageGateway {
  return {
    classify,
    list: async () => ({ status: 'degraded' }),
    read: async () => ({ status: 'degraded' }),
    noteWritten: async () => ({ status: 'degraded' })
  }
}

describe('classifyAll', () => {
  it('classifies paths in CLASSIFY_BATCH-sized chunks and returns every input path', async () => {
    const relPaths = Array.from({ length: CLASSIFY_BATCH * 2 + 5 }, (_, index) => `meeting-${index}.md`)
    const classify = vi.fn(async (batch: readonly string[]) => classMap(batch, ok))

    const classes = await classifyAll(fakeGateway(classify), relPaths)

    expect(classify).toHaveBeenCalledTimes(3)
    expect(classify.mock.calls.map(([batch]) => batch)).toEqual([
      relPaths.slice(0, CLASSIFY_BATCH),
      relPaths.slice(CLASSIFY_BATCH, CLASSIFY_BATCH * 2),
      relPaths.slice(CLASSIFY_BATCH * 2)
    ])
    expect(classes.size).toBe(relPaths.length)
    for (const relPath of relPaths) expect(classes.get(relPath)?.status).toBe('ok')
  })

  it('asks once more for only the files a batch left unknown and keeps the retry answer', async () => {
    const relPaths = ['ready.md', 'cold-a.md', 'missing.md', 'cold-b.md']
    const classify = vi.fn(async (batch: readonly string[]) => {
      if (classify.mock.calls.length === 1) {
        return classMap(batch, (relPath) => (relPath.startsWith('cold-') ? unknown() : relPath === 'missing.md' ? missing() : ok()))
      }
      return classMap(batch, ok)
    })

    const classes = await classifyAll(fakeGateway(classify), relPaths)

    expect(classify).toHaveBeenCalledTimes(2)
    expect(classify.mock.calls[0]?.[0]).toEqual(relPaths)
    expect(classify.mock.calls[1]?.[0]).toEqual(['cold-a.md', 'cold-b.md'])
    expect(classes.get('ready.md')?.status).toBe('ok')
    expect(classes.get('missing.md')?.status).toBe('missing')
    expect(classes.get('cold-a.md')?.status).toBe('ok')
    expect(classes.get('cold-b.md')?.status).toBe('ok')
  })

  it('does not retry a batch when every path has a definite first answer', async () => {
    const relPaths = ['ready.md', 'gone.md', 'still-ready.md']
    const classify = vi.fn(async (batch: readonly string[]) => classMap(batch, (relPath) => (relPath === 'gone.md' ? missing() : ok())))

    const classes = await classifyAll(fakeGateway(classify), relPaths)

    expect(classify).toHaveBeenCalledTimes(1)
    expect(classify.mock.calls[0]?.[0]).toEqual(relPaths)
    expect(classes.get('ready.md')?.status).toBe('ok')
    expect(classes.get('gone.md')?.status).toBe('missing')
    expect(classes.get('still-ready.md')?.status).toBe('ok')
  })

  it('returns an empty map without calling classify when there are no paths', async () => {
    const classify = vi.fn(async (batch: readonly string[]) => classMap(batch, ok))

    const classes = await classifyAll(fakeGateway(classify), [])

    expect(classes).toEqual(new Map())
    expect(classify).not.toHaveBeenCalled()
  })
})
