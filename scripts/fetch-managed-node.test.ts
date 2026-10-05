import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { download, isRetryableDownloadError } from './fetch-managed-node.mjs'
import { provisionManagedNodeArchive } from './lib/managed-node-provision.mjs'

const scratch: string[] = []
type HttpsGet = typeof import('node:https').get
type DownloadResponse = PassThrough & { statusCode: number; headers: Record<string, string> }

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(includeNode = true) {
  const root = mkdtempSync(join(tmpdir(), 'metis-provision-node-'))
  scratch.push(root)
  const file = 'node-v24.21.0-darwin-arm64.tar.gz'
  const inner = file.replace(/\.tar\.gz$/, '')
  const source = join(root, inner)
  mkdirSync(join(source, 'bin'), { recursive: true })
  writeFileSync(join(source, 'LICENSE'), 'fixture license')
  if (includeNode) writeFileSync(join(source, 'bin', 'node'), 'new binary fixture')
  const archive = join(root, file)
  execFileSync('tar', ['-czf', archive, '-C', root, inner])
  const dest = join(root, 'resources', 'managed-node', 'darwin-arm64')
  mkdirSync(join(dest, 'lib', 'node_modules', 'corepack'), { recursive: true })
  writeFileSync(join(dest, '.gitkeep'), '')
  writeFileSync(join(dest, 'lib', 'node_modules', 'corepack', 'removed-in-new-runtime.js'), 'old')
  writeFileSync(join(dest, '.node-version'), '22.22.3\n')
  return {
    root, archive, dest,
    spec: {
      file,
      sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
      nodeRelPath: 'bin/node'
    }
  }
}

describe('MQA-314: managed Node provisioning', () => {
  it('treats transient DNS and server failures as retryable, but not checksum failures', () => {
    expect(isRetryableDownloadError({ code: 'ENOTFOUND' })).toBe(true)
    expect(isRetryableDownloadError({ statusCode: 503 })).toBe(true)
    expect(isRetryableDownloadError(new Error('sha256 mismatch'))).toBe(false)
  })

  it('retries a transient download failure and promotes only the completed archive', async () => {
    const root = mkdtempSync(join(tmpdir(), 'metis-managed-node-download-'))
    scratch.push(root)
    const dest = join(root, 'node.tar.gz')
    let calls = 0
    const get = ((...args: unknown[]) => {
      const callback = args.find((arg): arg is (res: DownloadResponse) => void => typeof arg === 'function')
      if (!callback) throw new Error('missing response callback')
      calls += 1
      const req = new EventEmitter()
      process.nextTick(() => {
        if (calls === 1) {
          req.emit('error', Object.assign(new Error('getaddrinfo ENOTFOUND nodejs.org'), { code: 'ENOTFOUND' }))
          return
        }
        const res = Object.assign(new PassThrough(), { statusCode: 200, headers: {} })
        callback(res)
        res.end('archive bytes')
      })
      return req
    }) as HttpsGet

    await download('https://nodejs.org/dist/v24.21.0/node.tar.gz', dest, { get, attempts: 2, retryDelayMs: 0 })

    expect(calls).toBe(2)
    expect(readFileSync(dest, 'utf8')).toBe('archive bytes')
    expect(readdirSync(root)).toEqual(['node.tar.gz'])
  })

  it('promotes a verified complete archive, removing files from the previous Node release', () => {
    const { archive, dest, spec } = fixture()
    provisionManagedNodeArchive(archive, dest, spec, '24.21.0')
    expect(readFileSync(join(dest, 'bin', 'node'), 'utf8')).toBe('new binary fixture')
    expect(readFileSync(join(dest, '.node-version'), 'utf8')).toBe('24.21.0\n')
    expect(existsSync(join(dest, 'lib', 'node_modules', 'corepack'))).toBe(false)
    expect(readFileSync(join(dest, '.gitkeep'), 'utf8')).toBe('')
    expect(readdirSync(dirname(dest))).toEqual(['darwin-arm64'])
  })

  it('rejects an archive hash mismatch without modifying the previous runtime', () => {
    const { archive, dest, spec } = fixture()
    expect(() => provisionManagedNodeArchive(archive, dest, { ...spec, sha256: '0'.repeat(64) }, '24.21.0'))
      .toThrow(/sha256/)
    expect(readFileSync(join(dest, '.node-version'), 'utf8')).toBe('22.22.3\n')
    expect(readdirSync(dirname(dest))).toEqual(['darwin-arm64'])
  })

  it('does not promote or stamp an archive missing its actual node binary', () => {
    const { archive, dest, spec } = fixture(false)
    expect(() => provisionManagedNodeArchive(archive, dest, spec, '24.21.0')).toThrow(/node binary/)
    expect(readFileSync(join(dest, '.node-version'), 'utf8')).toBe('22.22.3\n')
    expect(readdirSync(dirname(dest))).toEqual(['darwin-arm64'])
  })
})
