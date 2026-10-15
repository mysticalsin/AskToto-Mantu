import { link, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { hashPinnedArchive } from './runtime-archive'

describe('runtime archive held-descriptor hashing', () => {
  it('hashes only the pinned length and detects a regular-file length mismatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metis-runtime-archive-'))
    try {
      const path = join(root, 'payload.tar.gz')
      const bytes = Buffer.from('archive bytes')
      await writeFile(path, bytes)
      await expect(hashPinnedArchive(path, bytes.byteLength)).resolves.toBe(
        createHash('sha256').update(bytes).digest('hex')
      )
      await expect(hashPinnedArchive(path, bytes.byteLength - 1)).rejects.toThrow('RUNTIME_ARCHIVE_SHAPE_MISMATCH')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a multiply linked regular archive before accepting its bytes on every host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metis-runtime-hardlink-'))
    try {
      const path = join(root, 'payload.tar.gz')
      const alias = join(root, 'second-name')
      const bytes = Buffer.from('archive bytes')
      await writeFile(path, bytes)
      await link(path, alias)
      await expect(hashPinnedArchive(path, bytes.byteLength)).rejects.toThrow('RUNTIME_ARCHIVE_SHAPE_MISMATCH')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
