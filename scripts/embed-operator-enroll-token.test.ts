import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_OPERATOR_URL } from '../src/shared/operator'
import { decryptProxyKey } from './lib/embedded-cloudflare-crypto.mjs'
import { defaultOperatorUrl } from './lib/operator-enroll-embed.mjs'
import { embedOperatorEnrollToken } from './embed-operator-enroll-token.mjs'

// Synthetic only. Never a real enrolment token.
const TOKEN = 'METIS-ENR-1.testkid.testsecret'
const dirs: string[] = []
function tempDir(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'metis-embed-enroll-')))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('embed-operator-enroll-token', () => {
  it('reads the same default URL as src/shared/operator.ts', () => {
    expect(defaultOperatorUrl()).toBe(DEFAULT_OPERATOR_URL)
  })

  it('is a no-op with a message when no token env is set, and writes nothing', () => {
    const outDir = join(tempDir(), 'operator-embed')
    const logs: string[] = []
    const result = embedOperatorEnrollToken({ env: {}, outDir, log: (m: string) => logs.push(m) })
    expect(result).toEqual({ wrote: false })
    expect(existsSync(join(outDir, 'enroll.json'))).toBe(false)
    expect(logs.join('\n')).toMatch(/METIS_OPERATOR_ENROLL_TOKEN/)
    expect(logs.join('\n')).toMatch(/SSO/)
  })

  it('removes a stale blob from an earlier tokened build when no token is set', () => {
    const outDir = tempDir()
    writeFileSync(join(outDir, 'enroll.json'), '{}')
    embedOperatorEnrollToken({ env: {}, outDir, log: () => undefined })
    expect(existsSync(join(outDir, 'enroll.json'))).toBe(false)
  })

  it('writes an AES-GCM blob of {token, operatorUrl} that decrypts with the shared material', () => {
    const outDir = join(tempDir(), 'operator-embed')
    const result = embedOperatorEnrollToken({
      env: { METIS_OPERATOR_ENROLL_TOKEN: ` ${TOKEN} ` },
      outDir,
      log: () => undefined
    })
    expect(result).toEqual({ wrote: true })
    const raw = readFileSync(join(outDir, 'enroll.json'), 'utf8')
    expect(raw).not.toContain(TOKEN)
    expect(raw).not.toContain('testsecret')
    const blob = JSON.parse(raw)
    expect(blob.alg).toBe('aes-256-gcm')
    expect(JSON.parse(decryptProxyKey(blob))).toEqual({ token: TOKEN, operatorUrl: DEFAULT_OPERATOR_URL })
  })

  it('honours METIS_OPERATOR_ENROLL_URL and strips trailing slashes', () => {
    const outDir = tempDir()
    embedOperatorEnrollToken({
      env: { METIS_OPERATOR_ENROLL_TOKEN: TOKEN, METIS_OPERATOR_ENROLL_URL: 'https://staging.example.test//' },
      outDir,
      log: () => undefined
    })
    const payload = JSON.parse(decryptProxyKey(JSON.parse(readFileSync(join(outDir, 'enroll.json'), 'utf8'))))
    expect(payload.operatorUrl).toBe('https://staging.example.test')
  })

  it('--qa mode reads only the QA variables', () => {
    const outDir = tempDir()
    const logs: string[] = []
    embedOperatorEnrollToken({
      env: { METIS_OPERATOR_ENROLL_TOKEN: TOKEN },
      outDir,
      qa: true,
      log: (m: string) => logs.push(m)
    })
    expect(existsSync(join(outDir, 'enroll.json'))).toBe(false)
    embedOperatorEnrollToken({
      env: { METIS_OPERATOR_ENROLL_TOKEN_QA: TOKEN, METIS_OPERATOR_ENROLL_URL_QA: 'https://qa.example.test' },
      outDir,
      qa: true,
      log: () => undefined
    })
    const payload = JSON.parse(decryptProxyKey(JSON.parse(readFileSync(join(outDir, 'enroll.json'), 'utf8'))))
    expect(payload).toEqual({ token: TOKEN, operatorUrl: 'https://qa.example.test' })
  })

  it('rejects a malformed token or a non-https URL without writing', () => {
    const outDir = tempDir()
    expect(() =>
      embedOperatorEnrollToken({ env: { METIS_OPERATOR_ENROLL_TOKEN: 'not-a-token' }, outDir, log: () => undefined })
    ).toThrow(/METIS-ENR-1/)
    expect(() =>
      embedOperatorEnrollToken({
        env: { METIS_OPERATOR_ENROLL_TOKEN: TOKEN, METIS_OPERATOR_ENROLL_URL: 'http://insecure.example.test' },
        outDir,
        log: () => undefined
      })
    ).toThrow(/https/)
    expect(existsSync(join(outDir, 'enroll.json'))).toBe(false)
  })

  it('the CLI entry exits 0 with the message and writes nothing when run without env', () => {
    const cwdOut = join(__dirname, '..', 'build', 'operator-embed', 'enroll.json')
    const before = existsSync(cwdOut)
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const k of Object.keys(env)) if (k.startsWith('METIS_OPERATOR_ENROLL')) delete env[k]
    // Run against a throwaway out dir so the working tree is never touched.
    const out = tempDir()
    mkdirSync(out, { recursive: true })
    const res = spawnSync(process.execPath, [join(__dirname, 'embed-operator-enroll-token.mjs')], {
      encoding: 'utf8',
      env: { ...env, METIS_OPERATOR_EMBED_OUT_DIR: out }
    })
    expect(res.status).toBe(0)
    expect(res.stdout).toMatch(/skipping/i)
    expect(existsSync(join(out, 'enroll.json'))).toBe(false)
    expect(existsSync(cwdOut)).toBe(before)
  })
})
