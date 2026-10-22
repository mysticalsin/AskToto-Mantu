import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRendererCrashThrottle, pruneCrashLogs } from './crash-log-prune'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'metis-crash-prune-')))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('pruneCrashLogs (D10-13)', () => {
  it('keeps the newest five crash logs, ordering numerically, and touches nothing else', async () => {
    const dir = await tempDir()
    const crashes = [
      'crash-100-0.log',
      'crash-100-1.log',
      'crash-100-9.log',
      'crash-100-10.log',
      'crash-101-0.log',
      'crash-90-3.log',
      'crash-102-0.log'
    ]
    for (const name of [...crashes, 'settings.json', 'crash-notes.txt']) await writeFile(join(dir, name), 'x')
    await pruneCrashLogs(dir, 5)
    const left = (await readdir(dir)).sort()
    // 90-3 and 100-0 are the two oldest; seq 10 sorts after seq 9 (a lexicographic sort would drop it).
    expect(left).toEqual(
      [
        'crash-100-1.log',
        'crash-100-10.log',
        'crash-100-9.log',
        'crash-101-0.log',
        'crash-102-0.log',
        'crash-notes.txt',
        'settings.json'
      ].sort()
    )
  })

  it('is a no-op when under the cap and never throws on a missing directory', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'crash-1-0.log'), 'x')
    await pruneCrashLogs(dir, 5)
    expect(await readdir(dir)).toEqual(['crash-1-0.log'])
    await expect(pruneCrashLogs(join(dir, 'missing'), 5)).resolves.toBeUndefined()
  })
})

describe('createRendererCrashThrottle (D10-13)', () => {
  it('allows one renderer crash file per 10 s', () => {
    let t = 1_000
    const allow = createRendererCrashThrottle(() => t)
    expect(allow()).toBe(true)
    t += 9_999
    expect(allow()).toBe(false)
    t += 1
    expect(allow()).toBe(true)
  })
})
