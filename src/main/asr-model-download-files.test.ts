import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AsrModelSpec } from './asr-model-manifest'

const electron = vi.hoisted(() => ({ app: { getPath: () => '/tmp/metis-asr-test-profile' }, net: {} }))
vi.mock('electron', () => electron)
vi.mock('./logger', () => ({ mainLog: { warn: vi.fn(), info: vi.fn() } }))

import { isHighTierAsrModelReady } from './asr-model-download'

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
