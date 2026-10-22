import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { encryptProxyKey } from './lib/embedded-cloudflare-crypto.mjs'
import { checkEmbeddedOperatorEnroll } from './check-embedded-operator-enroll.mjs'

const TOKEN = 'METIS-ENR-1.testkid.testsecret'
const URL_ = 'https://operator.example.test'
const dirs: string[] = []
function tempDir(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'metis-check-enroll-')))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Writes the packaged blob and, like a real build, the staged copy the packager read it from. */
function writeBlob(resources: string, payload: unknown, localBlob: string): void {
  mkdirSync(join(resources, 'operator-embed'), { recursive: true })
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const body = JSON.stringify(encryptProxyKey(text))
  writeFileSync(join(resources, 'operator-embed', 'enroll.json'), body)
  writeFileSync(localBlob, body)
}

/** A fixture package: <root>/resources, plus an empty local staging dir. */
function fixture(): { root: string; resources: string; localBlob: string } {
  const root = tempDir()
  const resources = join(root, 'resources')
  mkdirSync(resources, { recursive: true })
  return { root, resources, localBlob: join(tempDir(), 'enroll.json') }
}

describe('check-embedded-operator-enroll', () => {
  it('passes with a warning when no blob is staged or packaged and the token is not required', () => {
    const f = fixture()
    const r = checkEmbeddedOperatorEnroll({ dir: f.root, env: {}, localBlobPath: f.localBlob })
    expect(r.ok).toBe(true)
    expect(r.messages.join('\n')).toMatch(/SSO only/)
  })

  it('fails closed when METIS_OPERATOR_ENROLL_REQUIRED=1 and the package has no blob', () => {
    const f = fixture()
    const r = checkEmbeddedOperatorEnroll({
      dir: f.root,
      env: { METIS_OPERATOR_ENROLL_REQUIRED: '1' },
      localBlobPath: f.localBlob
    })
    expect(r.ok).toBe(false)
    expect(r.messages.join('\n')).toMatch(/operator-embed\/enroll\.json/)
  })

  it('passes a package whose blob decrypts to a METIS-ENR-1 token', () => {
    const f = fixture()
    writeBlob(f.resources, { token: TOKEN, operatorUrl: URL_ }, f.localBlob)
    const r = checkEmbeddedOperatorEnroll({
      dir: f.root,
      env: { METIS_OPERATOR_ENROLL_REQUIRED: '1' },
      localBlobPath: f.localBlob
    })
    expect(r).toMatchObject({ ok: true })
  })

  it('finds the mac layout (<dir>/Metis.app/Contents/Resources)', () => {
    const root = tempDir()
    const resources = join(root, 'Metis.app', 'Contents', 'Resources')
    mkdirSync(resources, { recursive: true })
    const localBlob = join(tempDir(), 'enroll.json')
    writeBlob(resources, { token: TOKEN, operatorUrl: URL_ }, localBlob)
    expect(checkEmbeddedOperatorEnroll({ dir: root, env: {}, localBlobPath: localBlob }).ok).toBe(true)
  })

  it('rejects a blob that does not decrypt, or a token with the wrong prefix, or a non-https URL', () => {
    for (const payload of [
      { token: 'METIS-ENR-2.a.b', operatorUrl: URL_ },
      { token: TOKEN, operatorUrl: 'http://operator.example.test' },
      'not json'
    ]) {
      const f = fixture()
      writeBlob(f.resources, payload, f.localBlob)
      expect(checkEmbeddedOperatorEnroll({ dir: f.root, env: {}, localBlobPath: f.localBlob }).ok).toBe(false)
    }
    const f = fixture()
    mkdirSync(join(f.resources, 'operator-embed'), { recursive: true })
    writeFileSync(
      join(f.resources, 'operator-embed', 'enroll.json'),
      JSON.stringify({ ciphertext: 'x', alg: 'aes-256-gcm' })
    )
    expect(checkEmbeddedOperatorEnroll({ dir: f.root, env: {}, localBlobPath: f.localBlob }).ok).toBe(false)
  })

  it('fails when a blob was staged for packaging but the package does not carry it', () => {
    const f = fixture()
    writeFileSync(f.localBlob, JSON.stringify(encryptProxyKey(JSON.stringify({ token: TOKEN, operatorUrl: URL_ }))))
    expect(checkEmbeddedOperatorEnroll({ dir: f.root, env: {}, localBlobPath: f.localBlob }).ok).toBe(false)
  })

  it('fails when the package carries a blob that was not staged (stale output dir)', () => {
    const f = fixture()
    writeBlob(f.resources, { token: TOKEN, operatorUrl: URL_ }, f.localBlob)
    rmSync(f.localBlob)
    expect(checkEmbeddedOperatorEnroll({ dir: f.root, env: {}, localBlobPath: f.localBlob }).ok).toBe(false)
  })

  it('fails when the plaintext token appears anywhere in the packaged resources', () => {
    const f = fixture()
    writeBlob(f.resources, { token: TOKEN, operatorUrl: URL_ }, f.localBlob)
    writeFileSync(join(f.resources, 'app.asar'), `junk ${TOKEN} junk`)
    const r = checkEmbeddedOperatorEnroll({ dir: f.root, env: {}, localBlobPath: f.localBlob })
    expect(r.ok).toBe(false)
    expect(r.messages.join('\n')).toMatch(/PLAINTEXT LEAK/)
  })
})
