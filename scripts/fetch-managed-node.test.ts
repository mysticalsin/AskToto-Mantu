import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { createServer, get as httpGet } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fetchVerifiedArchive } from './fetch-managed-node.mjs'
import { provisionManagedNodeArchive } from './lib/managed-node-provision.mjs'

const scratch: string[] = []
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

describe('managed Node download on a CI runner', () => {
  // Packaged smoke run 37174602417 failed on macOS with "getaddrinfo ENOTFOUND nodejs.org": a single
  // DNS miss failed the whole build because this download had no retry.
  it('retries a transient DNS failure and keeps the archive', async () => {
    const body = Buffer.from('archive bytes')
    const sha256 = createHash('sha256').update(body).digest('hex')
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-length': String(body.length) })
      response.end(body)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/node.tar.gz`
    const root = mkdtempSync(join(tmpdir(), 'metis-managed-node-retry-'))
    scratch.push(root)
    const archive = join(root, 'node.tar.gz')
    let calls = 0
    const requestGet = ((target: string, callback: never) => {
      calls += 1
      if (calls > 1) return httpGet(target, callback)
      const failing = new EventEmitter() as EventEmitter & { destroy: () => void }
      failing.destroy = () => {}
      setImmediate(() => failing.emit('error', Object.assign(new Error('getaddrinfo ENOTFOUND nodejs.org'), { code: 'ENOTFOUND' })))
      return failing
    }) as never
    try {
      await fetchVerifiedArchive(url, archive, sha256, { requestGet, backoffBaseMs: 1 })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    expect(calls).toBe(2)
    expect(readFileSync(archive)).toEqual(body)
  })

  it('discards a cached archive whose hash does not match and fetches it again', async () => {
    const body = Buffer.from('fresh archive')
    const sha256 = createHash('sha256').update(body).digest('hex')
    const server = createServer((_request, response) => response.end(body))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/node.tar.gz`
    const root = mkdtempSync(join(tmpdir(), 'metis-managed-node-stale-'))
    scratch.push(root)
    const archive = join(root, 'node.tar.gz')
    writeFileSync(archive, 'truncated')
    try {
      await fetchVerifiedArchive(url, archive, sha256, { requestGet: httpGet, backoffBaseMs: 1 })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    expect(readFileSync(archive)).toEqual(body)
  })

  it('reuses a cached archive whose hash matches without any request', async () => {
    const body = Buffer.from('cached archive')
    const root = mkdtempSync(join(tmpdir(), 'metis-managed-node-cached-'))
    scratch.push(root)
    const archive = join(root, 'node.tar.gz')
    writeFileSync(archive, body)
    const requestGet = (() => {
      throw new Error('no request expected')
    }) as never
    await fetchVerifiedArchive('http://127.0.0.1:9/node.tar.gz', archive, createHash('sha256').update(body).digest('hex'), { requestGet })
    expect(readFileSync(archive)).toEqual(body)
  })
})
