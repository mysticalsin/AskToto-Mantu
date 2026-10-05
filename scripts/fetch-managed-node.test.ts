import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, get as httpGet, type RequestListener, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { download } from './fetch-managed-node.mjs'
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

async function startServer(listener: RequestListener) {
  const sockets = new Set<Socket>()
  const server = createServer(listener)
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port')
  return { server, sockets, url: `http://127.0.0.1:${address.port}/node.tar.gz` }
}

async function stopServer(server: Server, sockets: Set<Socket>) {
  for (const socket of sockets) socket.destroy()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
}

function settleDownload(operation: Promise<void>) {
  return operation.then(
    () => ({ kind: 'resolved' as const, error: null }),
    (error: Error) => ({ kind: 'rejected' as const, error })
  )
}

function neverRespondingRequestGet(onAttempt: () => void): typeof httpGet {
  return (() => {
    onAttempt()
    const request = new EventEmitter() as EventEmitter & { destroy(error?: Error): void }
    request.destroy = (error) => {
      if (error) request.emit('error', error)
    }
    return request
  }) as unknown as typeof httpGet
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

describe('managed Node archive download timeouts', () => {
  it('bounds a connection that never sends response headers and retries clearly', async () => {
    let attempts = 0
    const requestGet = neverRespondingRequestGet(() => { attempts += 1 })
    const root = mkdtempSync(join(tmpdir(), 'metis-managed-node-request-timeout-'))
    scratch.push(root)
    const destination = join(root, 'node.tar.gz')

    const outcome = await settleDownload(
      download('http://127.0.0.1/node.tar.gz', destination, {
        requestGet,
        requestTimeoutMs: 500,
        responseIdleTimeoutMs: 500,
        maxAttempts: 2,
        backoffBaseMs: 1
      })
    )

    expect(outcome.kind).toBe('rejected')
    expect(outcome.error?.message).toMatch(/request timeout after 500ms/)
    expect(attempts).toBe(2)
    expect(existsSync(`${destination}.part`)).toBe(false)
  })

  it('bounds a response body that starts and then stalls, without confusing it for header timeout', async () => {
    let requests = 0
    const { server, sockets, url } = await startServer((_request, response) => {
      requests += 1
      response.writeHead(200, { 'content-length': '2' })
      response.flushHeaders()
      response.write('x')
    })
    const root = mkdtempSync(join(tmpdir(), 'metis-managed-node-idle-timeout-'))
    scratch.push(root)
    const destination = join(root, 'node.tar.gz')

    try {
      const outcome = await settleDownload(
        download(url, destination, {
          requestGet: httpGet,
          requestTimeoutMs: 5_000,
          responseIdleTimeoutMs: 500,
          maxAttempts: 2,
          backoffBaseMs: 1
        })
      )

      expect(outcome.kind).toBe('rejected')
      expect(outcome.error?.message).toMatch(/response idle timeout after 500ms/)
      expect(requests).toBe(2)
      expect(existsSync(`${destination}.part`)).toBe(false)
    } finally {
      await stopServer(server, sockets)
    }
  })
})
