import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// This is the installed electron-updater consumer, not a second YAML implementation. Its synchronous
// loader runs in a disposable child so a dependency regression cannot hang the Vitest worker. The
// advisory fixture performs only 101 * 101 empty merges even on an unpatched loader (under 2.5 KiB).
// No app bootstrap, update-feed request, installer, or user data is touched.
const ROOT = resolve(__dirname, '..')
const SHA512 = 'FOM1HCfIV6KD7Fic3ayhzC+Gp9KM0tnXecrPBkIVa8zdpNEQw03mTO7VUB4z/9hzxAhpF3aVdpkG4yihVuEhUw=='
const BODY = 'metis-updater-fixture'
let profile: string

beforeAll(() => { profile = mkdtempSync(join(tmpdir(), 'metis-updater-yaml-test-')) })
afterAll(() => { if (profile) rmSync(profile, { recursive: true, force: true }) })

const CONSUMER = String.raw`
const { readFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const { Readable, Writable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const consumerPath = require.resolve('electron-updater/out/providers/Provider.js')
const consumerRequire = createRequire(consumerPath)
const { parseUpdateInfo, resolveFiles } = require(consumerPath)
const { DigestTransform } = consumerRequire('builder-util-runtime')
const input = JSON.parse(readFileSync(0, 'utf8'))
;(async () => {
  try {
    const parsed = parseUpdateInfo(input.yaml, input.channel, 'https://updates.invalid/fixtures/' + input.channel)
    const resolved = resolveFiles(parsed, new URL('https://updates.invalid/fixtures/'))
    let digest
    if (input.body !== undefined) {
      const verifier = new DigestTransform(resolved[0].info.sha512, 'sha512', 'base64')
      await pipeline(Readable.from([Buffer.from(input.body)]), verifier, new Writable({
        write(_chunk, _encoding, done) { done() }
      }))
      digest = verifier.actual
    }
    process.stdout.write(JSON.stringify({ ok: true, parsed, resolved, digest }))
  } catch (error) {
    // parseUpdateInfo embeds its raw YAML in the exception. Keep even synthetic input out of logs;
    // assert the consumer's error code and the budget category, never its raw response/stack.
    process.stdout.write(JSON.stringify({
      ok: false,
      code: typeof error?.code === 'string' ? error.code : null,
      mergeRejection: /merge keys exceeded maxTotalMergeKeys/.test(String(error?.message || ''))
        ? 'work-budget'
        : /abnormal merge sequence size/.test(String(error?.message || '')) ? 'source-count' : null
    }))
  }
})().catch(() => { process.exitCode = 1 })
`

interface ConsumerResult {
  ok: boolean
  parsed?: Record<string, unknown>
  resolved?: Array<{ url: string; info: Record<string, unknown> }>
  digest?: string
  code?: string | null
  mergeRejection?: 'work-budget' | 'source-count' | null
}

function consume(yaml: string | null, channel = 'latest.yml', body?: string): ConsumerResult {
  const child = spawnSync(process.execPath, ['--max-old-space-size=96', '-e', CONSUMER], {
    cwd: ROOT,
    env: { ...process.env, ASKTOTO_USERDATA: profile, NODE_OPTIONS: '' },
    input: JSON.stringify({ yaml, channel, body }),
    encoding: 'utf8',
    timeout: 5_000,
    killSignal: 'SIGKILL',
    maxBuffer: 128 * 1024
  })
  // A timeout/crash is a failure, not acceptable rejection of malformed update metadata.
  expect(child.error, 'updater consumer must exit within its subprocess bound').toBeUndefined()
  expect(child.signal).toBeNull()
  expect(child.status).toBe(0)
  expect(child.stderr).toBe('')
  return JSON.parse(child.stdout) as ConsumerResult
}

function metadata(filename: string): string {
  return `version: 9.9.9-fixture
files:
  - url: ${filename}
    sha512: ${SHA512}
    size: 20
path: ${filename}
sha512: ${SHA512}
releaseDate: '2026-09-09T00:00:00.000Z'
releaseNotes: 'Métis — synthetic update only'
`
}

describe('installed electron-updater YAML compatibility and integrity', () => {
  it.each([
    ['latest.yml', 'Metis-Setup-9.9.9-fixture.exe'],
    ['latest-mac.yml', 'Metis-9.9.9-fixture.zip']
  ])('preserves %s metadata through parsing, URL resolution, and byte integrity verification', (channel, filename) => {
    const result = consume(metadata(filename), channel, BODY)
    expect(result).toEqual({
      ok: true,
      parsed: {
        version: '9.9.9-fixture',
        files: [{ url: filename, sha512: SHA512, size: 20 }],
        path: filename,
        sha512: SHA512,
        releaseDate: '2026-09-09T00:00:00.000Z',
        releaseNotes: 'Métis — synthetic update only'
      },
      resolved: [{ url: `https://updates.invalid/fixtures/${filename}`, info: { url: filename, sha512: SHA512, size: 20 } }],
      digest: SHA512
    })
  })

  it('preserves an ordinary YAML alias/merge in a valid update file entry', () => {
    const result = consume(`version: 9.9.9-fixture
defaults: &defaults
  url: Metis-Setup-9.9.9-fixture.exe
  sha512: ${SHA512}
  size: 20
files:
  - <<: *defaults
`, 'latest.yml', BODY)
    expect(result.ok).toBe(true)
    expect(result.resolved).toEqual([{
      url: 'https://updates.invalid/fixtures/Metis-Setup-9.9.9-fixture.exe',
      info: { url: 'Metis-Setup-9.9.9-fixture.exe', sha512: SHA512, size: 20 }
    }])
    expect(result.digest).toBe(SHA512)
  })

  it.each([null, 'version: 9.9.9-fixture\nfiles: ['])('rejects a missing or malformed feed without silently producing an update', (yaml) => {
    expect(consume(yaml)).toMatchObject({ ok: false, code: 'ERR_UPDATER_INVALID_UPDATE_INFO' })
  })

  it('refuses a parsed update entry with no integrity checksum', () => {
    expect(consume('version: 9.9.9-fixture\nfiles:\n  - url: Metis-Setup-9.9.9-fixture.exe\n')).toMatchObject({
      ok: false,
      code: 'ERR_UPDATER_NO_CHECKSUM'
    })
  })

  it('rejects changed artifact bytes using the checksum parsed from the feed', () => {
    expect(consume(metadata('Metis-Setup-9.9.9-fixture.exe'), 'latest.yml', `${BODY}!`)).toMatchObject({
      ok: false,
      code: 'ERR_CHECKSUM_MISMATCH'
    })
  })

  it.each([
    [100, 'work-budget'],
    [101, 'source-count']
  ] as const)('rejects %i empty sources repeated 101 times through the updater (GHSA-2883-xcg3-v3hh)', (sources, rejection) => {
    const yaml = metadata('Metis-Setup-9.9.9-fixture.exe') +
      `empty: &empty [${Array(sources).fill('{}').join(',')}]\ntargets:\n` +
      '  - <<: *empty\n'.repeat(101)
    // 100 * 101 reaches the 10,000-unit budget; 101 sources hits the patched per-sequence limit first.
    // The original 101-source fixture was accepted by 4.3.1. Neither timeout nor arbitrary parse error
    // counts as green; the 100-source case also prevents the earlier guard from hiding a broken budget.
    expect(Buffer.byteLength(yaml)).toBeLessThan(2_500)
    expect(consume(yaml)).toMatchObject({
      ok: false,
      code: 'ERR_UPDATER_INVALID_UPDATE_INFO',
      mergeRejection: rejection
    })
  })
})
