import { mkdtemp, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const captured = vi.hoisted(() => ({ writes: [] as Array<{ path: string; options: unknown }> }))

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp' } }))
vi.mock('./logger', () => ({ mainLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, auditLog: vi.fn() }))
vi.mock('./mac-helper', () => ({ macHelperPresent: () => true, macHelperPath: () => 'metis-mac-helper-absent' }))
vi.mock('node:child_process', () => ({
  spawn: () => {
    throw new Error('spawn is not available in this test')
  }
}))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    writeFileSync: (path: unknown, _data: unknown, options: unknown) => {
      captured.writes.push({ path: String(path), options })
    },
    unlinkSync: () => {}
  }
})

import { appleSpeechTranscribe, sweepAppleSpeechTemp } from './apple-speech'

const originalPlatform = process.platform
const dirs: string[] = []
afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  captured.writes.length = 0
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('apple speech temp audio (D9-12)', () => {
  it('writes the temp file owner-only (0o600)', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    await appleSpeechTranscribe(new Float32Array(160))
    expect(captured.writes).toHaveLength(1)
    expect(captured.writes[0].path).toMatch(/metis-apple-speech-.*\.wav$/)
    expect(captured.writes[0].options).toMatchObject({ mode: 0o600 })
  })

  it('sweeps stale metis-apple-speech-*.wav files at boot and nothing else', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'metis-apple-sweep-')))
    dirs.push(dir)
    const stale = join(dir, 'metis-apple-speech-aaaa.wav')
    const fresh = join(dir, 'metis-apple-speech-bbbb.wav')
    const unrelated = join(dir, 'other.wav')
    for (const f of [stale, fresh, unrelated]) await writeFile(f, 'x')
    const old = new Date(Date.now() - 10 * 60_000)
    await utimes(stale, old, old)
    await utimes(unrelated, old, old)
    await sweepAppleSpeechTemp(dir)
    expect((await readdir(dir)).sort()).toEqual(['metis-apple-speech-bbbb.wav', 'other.wav'])
  })

  it('never throws when the directory is missing', async () => {
    await expect(sweepAppleSpeechTemp(join(tmpdir(), 'metis-definitely-missing-dir'))).resolves.toBeUndefined()
  })
})
