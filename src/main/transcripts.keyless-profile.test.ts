import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { decodeSavedResult } from './transcripts'

vi.mock('electron')

/** A v2 envelope whose content key is 'F:'-wrapped under a file key this profile never held: a transcript or
 *  brain index synced from another install. */
function envelopeFromAnotherInstall(): Buffer {
  const env = {
    v: 2,
    iv: randomBytes(12).toString('base64'),
    tag: randomBytes(16).toString('base64'),
    ct: randomBytes(32).toString('base64'),
    kLocal: 'F:' + randomBytes(72).toString('base64')
  }
  return Buffer.concat([Buffer.from('ATKENC2\n', 'utf8'), Buffer.from(JSON.stringify(env), 'utf8')])
}

describe('a file-key envelope from another install, on a profile with no key file', () => {
  let userData: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'metis-keyless-'))
    vi.mocked(app.getPath).mockReturnValue(userData)
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  it('decodes as unreadable here and leaves no secret-key.bin behind', () => {
    expect(decodeSavedResult(envelopeFromAnotherInstall())).toEqual({
      ok: false,
      reason: expect.stringContaining('no file key')
    })
    expect(existsSync(join(userData, 'secret-key.bin'))).toBe(false)
  })
})
