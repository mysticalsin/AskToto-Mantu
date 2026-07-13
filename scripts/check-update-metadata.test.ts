import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { verifyUpdateMetadata } from './check-update-metadata.mjs'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture({ path = 'Metis-1.0.2.zip', hash = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'metis-update-metadata-'))
  scratch.push(dir)
  const payload = Buffer.from('reviewed update payload')
  if (!/[\\/]/.test(path)) writeFileSync(join(dir, path), payload)
  const sha512 = hash
    ? createHash('sha512').update(payload).digest('base64')
    : Buffer.alloc(64, 7).toString('base64')
  const metadata = join(dir, 'latest-mac.yml')
  writeFileSync(
    metadata,
    `version: 1.0.2\nfiles:\n  - url: ${path}\n    sha512: ${sha512}\npath: ${path}\nsha512: ${sha512}\nreleaseDate: '2026-07-13T00:00:00.000Z'\n`
  )
  return { metadata }
}

describe('verifyUpdateMetadata', () => {
  it('accepts a version-matched metadata file whose top-level SHA-512 matches the payload', async () => {
    const { metadata } = fixture()
    await expect(verifyUpdateMetadata(metadata, '1.0.2')).resolves.toMatchObject({
      version: '1.0.2',
      artifact: 'Metis-1.0.2.zip'
    })
  })

  it('rejects stale or tampered payload bytes', async () => {
    const { metadata } = fixture({ hash: false })
    await expect(verifyUpdateMetadata(metadata, '1.0.2')).rejects.toThrow('SHA-512 mismatch')
  })

  it('rejects metadata paths that escape the artifact directory', async () => {
    const { metadata } = fixture({ path: '../Metis-1.0.2.zip' })
    await expect(verifyUpdateMetadata(metadata, '1.0.2')).rejects.toThrow('plain artifact filename')
  })
})
