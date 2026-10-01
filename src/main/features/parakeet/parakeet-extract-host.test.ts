import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const extractTarBz2Windows = vi.hoisted(() => vi.fn())

vi.mock('../../scripts/tar-bz2-extract.mjs', () => ({ extractTarBz2Windows }))

import { attachParakeetExtractHost } from './parakeet-extract-host'

class FakePort extends EventEmitter {
  readonly postMessage = vi.fn()
  readonly start = vi.fn()
}

describe('Parakeet extraction utility host', () => {
  it('uses the reviewed in-process Windows extractor and reports completion', () => {
    const port = new FakePort()
    attachParakeetExtractHost(port)

    port.emit('message', { type: 'extract', archivePath: 'archive.tar.bz2', destDir: 'staging' })

    expect(extractTarBz2Windows).toHaveBeenCalledWith('archive.tar.bz2', 'staging')
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'result' })
  })

  it('returns a bounded error to the parent when extraction fails', () => {
    extractTarBz2Windows.mockImplementationOnce(() => {
      throw new Error('bad archive')
    })
    const port = new FakePort()
    attachParakeetExtractHost(port)

    port.emit('message', { type: 'extract', archivePath: 'archive.tar.bz2', destDir: 'staging' })

    expect(port.postMessage).toHaveBeenCalledWith({ type: 'error', message: 'bad archive' })
  })
})
