import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AsrModelSpec } from './asr-model-manifest'

const electron = vi.hoisted(() => {
  const profile = { path: '/tmp/metis-asr-test-profile' }
  return {
    profile,
    app: { getPath: () => profile.path },
    net: { fetch: vi.fn() }
  }
})
vi.mock('electron', () => electron)
vi.mock('./logger', () => ({ mainLog: { warn: vi.fn(), info: vi.fn() } }))

import { ensureHighTierAsrModel, isHighTierAsrModelReady } from './asr-model-download'

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

const FIXTURE: AsrModelSpec = {
  id: 'fixture/whisper-large',
  revision: '0123456789012345678901234567890123456789',
  files: [
    { path: 'onnx/encoder.onnx', bytes: 3, sha256: sha256('abc') },
    { path: 'tokenizer.json', bytes: 2, sha256: sha256('xy') }
  ]
}

describe('isHighTierAsrModelReady', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'metis-high-tier-files-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function write(path: string, bytes: string): void {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, bytes)
  }

  it('requires every pinned high-tier file to match its size and digest, not just the model directory', async () => {
    const dir = join(root, ...FIXTURE.id.split('/'))
    mkdirSync(dir, { recursive: true })
    await expect(isHighTierAsrModelReady(FIXTURE, root)).resolves.toBe(false)

    write(join(dir, 'onnx', 'encoder.onnx'), 'abc')
    await expect(isHighTierAsrModelReady(FIXTURE, root)).resolves.toBe(false)

    write(join(dir, 'tokenizer.json'), 'x')
    await expect(isHighTierAsrModelReady(FIXTURE, root)).resolves.toBe(false)

    write(join(dir, 'tokenizer.json'), 'xy')
    await expect(isHighTierAsrModelReady(FIXTURE, root)).resolves.toBe(true)
  })

  it('rejects same-length tampering', async () => {
    const dir = join(root, ...FIXTURE.id.split('/'))
    write(join(dir, 'onnx', 'encoder.onnx'), 'bad')
    write(join(dir, 'tokenizer.json'), 'xy')

    await expect(isHighTierAsrModelReady(FIXTURE, root)).resolves.toBe(false)
  })
})

describe('high-tier ASR downloader byte bounds', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'metis-asr-download-'))
    electron.profile.path = root
    electron.net.fetch.mockReset()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function response(chunks: string[], contentLength?: number): unknown {
    let index = 0
    const headers =
      contentLength === undefined ? new Headers() : new Headers({ 'content-length': String(contentLength) })
    return {
      ok: true,
      status: 200,
      headers,
      body: new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (index < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[index++]))
            else controller.close()
          }
        },
        { highWaterMark: 0 }
      )
    }
  }

  it.each([
    ['missing Content-Length', undefined],
    ['matching Content-Length', 2]
  ] as const)('cancels an oversized %s response before consuming further bytes', async (_label, headerBytes) => {
    const modelDir = join(root, 'asr-models', ...FIXTURE.id.split('/'))
    const priorFile = join(modelDir, 'onnx', 'encoder.onnx')
    mkdirSync(dirname(priorFile), { recursive: true })
    writeFileSync(priorFile, 'abc')
    const partialFile = join(modelDir, 'tokenizer.json.partial')
    let consumed = 0
    let cancelled = false
    let index = 0
    const chunks = ['x', 'yz', 'more']
    const responseBody = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (index < chunks.length) {
            consumed += 1
            controller.enqueue(new TextEncoder().encode(chunks[index++]))
          } else controller.close()
        },
        cancel() {
          cancelled = true
        }
      },
      { highWaterMark: 0 }
    )
    electron.net.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: headerBytes === undefined ? new Headers() : new Headers({ 'content-length': String(headerBytes) }),
      body: responseBody
    })

    await expect(ensureHighTierAsrModel(FIXTURE)).resolves.toBe(false)

    expect(consumed).toBe(2)
    expect(cancelled).toBe(true)
    expect(responseBody.locked).toBe(false)
    expect(readFileSync(priorFile, 'utf8')).toBe('abc')
    expect(existsSync(partialFile)).toBe(false)
    expect(electron.net.fetch).toHaveBeenCalledTimes(1)
  })

  it('accepts an exact-size chunked response without Content-Length and verifies its digest', async () => {
    electron.net.fetch.mockResolvedValueOnce(response(['abc'])).mockResolvedValueOnce(response(['xy']))

    await expect(ensureHighTierAsrModel(FIXTURE)).resolves.toBe(true)
    expect(await isHighTierAsrModelReady(FIXTURE, join(root, 'asr-models'))).toBe(true)
    expect(electron.net.fetch).toHaveBeenCalledTimes(2)
  })
})
