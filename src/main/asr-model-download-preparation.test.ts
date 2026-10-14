import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AsrModelSpec } from './asr-model-manifest'

const fixture = vi.hoisted(() => ({
  profile: '',
  fetch: vi.fn(),
  stat: vi.fn(),
  mkdir: vi.fn(),
  statfs: vi.fn()
}))

vi.mock('electron', () => ({ app: { getPath: () => fixture.profile }, net: { fetch: fixture.fetch } }))
vi.mock('./logger', () => ({ mainLog: { warn: vi.fn(), info: vi.fn() } }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, stat: fixture.stat, mkdir: fixture.mkdir, statfs: fixture.statfs }
})

type Downloader = typeof import('./asr-model-download')
const bytes = 'bounded-model-fixture'
const spec: AsrModelSpec = {
  id: 'fixture/preparation',
  revision: '0123456789012345678901234567890123456789',
  files: [
    { path: 'model.onnx', bytes: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex') }
  ]
}

function latch(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

let api: Downloader
let actualFs: typeof import('node:fs/promises')

beforeEach(async () => {
  fixture.profile = mkdtempSync(join(tmpdir(), 'metis-asr-preparation-'))
  actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  fixture.stat.mockReset().mockImplementation(actualFs.stat)
  fixture.mkdir.mockReset().mockImplementation(actualFs.mkdir)
  fixture.statfs.mockReset().mockResolvedValue({ bavail: 1_000_000, bsize: 4096 })
  fixture.fetch.mockReset().mockImplementation(async () => new Response(bytes))
  vi.resetModules()
  api = await import('./asr-model-download')
})

afterEach(() => {
  rmSync(fixture.profile, { recursive: true, force: true })
})

it('awaits asynchronous file metadata before admitting a ready model', async () => {
  const root = join(fixture.profile, 'asr-models')
  const directory = join(root, ...spec.id.split('/'))
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'model.onnx'), bytes)
  const gate = latch()
  fixture.stat.mockImplementationOnce(async (...args: Parameters<typeof actualFs.stat>) => {
    await gate.promise
    return actualFs.stat(...args)
  })
  let settled = false
  const pending = api.isHighTierAsrModelReady(spec, root).finally(() => {
    settled = true
  })
  try {
    await vi.waitFor(() => expect(fixture.stat).toHaveBeenCalledTimes(1))
    expect(settled).toBe(false)
    expect(fixture.fetch).not.toHaveBeenCalled()
  } finally {
    gate.release()
    await expect(pending).resolves.toBe(true)
  }
})

it('shares the transfer while preparatory mkdir is held and starts no network early', async () => {
  const gate = latch()
  fixture.mkdir.mockImplementationOnce(async (...args: Parameters<typeof actualFs.mkdir>) => {
    await gate.promise
    return actualFs.mkdir(...args)
  })
  const pending = api.ensureHighTierAsrModel(spec)
  try {
    await vi.waitFor(() => expect(fixture.mkdir).toHaveBeenCalledTimes(1))
    expect(api.ensureHighTierAsrModel(spec)).toBe(pending)
    expect(fixture.statfs).not.toHaveBeenCalled()
    expect(fixture.fetch).not.toHaveBeenCalled()
  } finally {
    gate.release()
    await expect(pending).resolves.toBe(true)
  }
  expect(fixture.fetch).toHaveBeenCalledTimes(1)
  expect(await api.isHighTierAsrModelReady(spec)).toBe(true)
})

it('keeps single-flight ownership and refuses networking until disk admission settles', async () => {
  const gate = latch()
  fixture.statfs.mockImplementationOnce(async () => {
    await gate.promise
    return { bavail: 1_000_000, bsize: 4096 }
  })
  const pending = api.ensureHighTierAsrModel(spec)
  try {
    await vi.waitFor(() => expect(fixture.statfs).toHaveBeenCalledTimes(1))
    expect(api.ensureHighTierAsrModel(spec)).toBe(pending)
    expect(fixture.fetch).not.toHaveBeenCalled()
  } finally {
    gate.release()
    await expect(pending).resolves.toBe(true)
  }
  expect(fixture.fetch).toHaveBeenCalledTimes(1)
  expect(api.asrModelDownloadState().status).toBe('ready')
})

it('refuses insufficient space before fetching and preserves the error state', async () => {
  fixture.statfs.mockResolvedValue({ bavail: 0, bsize: 4096 })
  await expect(api.ensureHighTierAsrModel(spec)).resolves.toBe(false)
  expect(fixture.fetch).not.toHaveBeenCalled()
  expect(api.asrModelDownloadState()).toMatchObject({ status: 'error', progress: 0 })
})

it('retains the existing unmeasurable-volume behavior without skipping digest validation', async () => {
  fixture.statfs.mockRejectedValue(new Error('fixture-volume-unavailable'))
  fixture.fetch.mockImplementation(async () => new Response('wrong-model-bytes'))
  await expect(api.ensureHighTierAsrModel(spec)).resolves.toBe(false)
  expect(fixture.fetch).toHaveBeenCalledTimes(1)
  expect(api.asrModelDownloadState().status).toBe('error')
})
