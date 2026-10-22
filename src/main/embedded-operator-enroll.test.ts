import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { encryptProxyKey } from '../../scripts/lib/embedded-cloudflare-crypto.mjs'
import {
  primeEmbeddedOperatorEnroll,
  readEmbeddedOperatorEnrollToken,
  setEmbeddedOperatorEnrollProvider
} from './embedded-operator-enroll'

const TOKEN = 'METIS-ENR-1.testkid.testsecret'
const URL_ = 'https://operator.example.test'
const dirs: string[] = []
function blobFile(payload: unknown): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'metis-enroll-runtime-')))
  dirs.push(d)
  mkdirSync(join(d, 'operator-embed'))
  const file = join(d, 'operator-embed', 'enroll.json')
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  writeFileSync(file, JSON.stringify(encryptProxyKey(text)))
  return file
}
afterEach(() => {
  setEmbeddedOperatorEnrollProvider(null)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('primeEmbeddedOperatorEnroll', () => {
  it('returns null and installs nothing when there is no packaged blob (every dev and SSO-only build)', async () => {
    await primeEmbeddedOperatorEnroll(join(tmpdir(), 'metis-enroll-missing', 'enroll.json'))
    expect(readEmbeddedOperatorEnrollToken()).toBeNull()
  })

  it('decrypts the packaged blob the build script produced and serves it', async () => {
    await primeEmbeddedOperatorEnroll(blobFile({ token: TOKEN, operatorUrl: `${URL_}/` }))
    expect(readEmbeddedOperatorEnrollToken()).toEqual({ token: TOKEN, operatorUrl: URL_ })
  })

  it('ignores a blob with a malformed token, a non-https URL, non-JSON, or tampered ciphertext', async () => {
    for (const payload of [
      { token: 'bad', operatorUrl: URL_ },
      { token: TOKEN, operatorUrl: 'http://x.test' },
      'plain'
    ]) {
      await primeEmbeddedOperatorEnroll(blobFile(payload))
      expect(readEmbeddedOperatorEnrollToken()).toBeNull()
    }
    const file = blobFile({ token: TOKEN, operatorUrl: URL_ })
    writeFileSync(file, JSON.stringify({ ...encryptProxyKey('x'), ciphertext: 'AAAA' }))
    await primeEmbeddedOperatorEnroll(file)
    expect(readEmbeddedOperatorEnrollToken()).toBeNull()
  })

  it('never rejects, even for a corrupt file', async () => {
    const file = blobFile({ token: TOKEN, operatorUrl: URL_ })
    writeFileSync(file, '{not json')
    await expect(primeEmbeddedOperatorEnroll(file)).resolves.toBeUndefined()
    expect(readEmbeddedOperatorEnrollToken()).toBeNull()
  })
})
