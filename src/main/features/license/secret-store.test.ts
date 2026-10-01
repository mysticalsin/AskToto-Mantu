import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from 'electron'

vi.mock('electron')

import { clearLicenseCache, readLicenseCache, writeLicenseCache } from './secret-store'

describe('license secret store', () => {
  let ud: string

  beforeEach(() => {
    ud = mkdtempSync(join(tmpdir(), 'metis-lic-cache-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((n: string) => (n === 'userData' ? ud : join(ud, n)))
  })

  afterEach(() => {
    rmSync(ud, { recursive: true, force: true })
  })

  it('round-trips a cache blob without writing plaintext JWS to disk', () => {
    writeLicenseCache(
      { jws: 'aaa.bbb.ccc', cachedAt: 1, kid: 'metis-2026-1', edition: 'pro', source: 'cache' },
      ud
    )
    const raw = readFileSync(join(ud, 'license-cache.bin'))
    expect(raw.toString('utf8')).not.toContain('aaa.bbb.ccc')
    expect(readLicenseCache(ud)).toEqual({
      jws: 'aaa.bbb.ccc',
      cachedAt: 1,
      kid: 'metis-2026-1',
      edition: 'pro',
      source: 'cache'
    })
    clearLicenseCache(ud)
    expect(readLicenseCache(ud)).toBeNull()
  })

  it('missing or garbage cache is Unlicensed, not a throw', () => {
    expect(readLicenseCache(ud)).toBeNull()
    writeLicenseCache(
      { jws: 'aaa.bbb.ccc', cachedAt: 1, kid: 'metis-2026-1', edition: 'personal', source: 'file' },
      ud
    )
    // Corrupt the file: unwrap will fail closed.
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(join(ud, 'license-cache.bin'), Buffer.from('not-a-secret'))
    expect(readLicenseCache(ud)).toBeNull()
  })
})
