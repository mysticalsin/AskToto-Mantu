import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { get as httpGet, createServer, type RequestListener, type Server } from 'node:http'
import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { download } from './fetch-llama-server.mjs'

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
  return { server, sockets, url: `http://127.0.0.1:${address.port}/llama.zip` }
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

describe('llama-server archive download timeouts', () => {
  it('bounds a connection that never sends response headers and retries clearly', async () => {
    let attempts = 0
    const requestGet = neverRespondingRequestGet(() => { attempts += 1 })
    const url = 'http://127.0.0.1/llama.zip'
    const scratch = mkdtempSync(join(tmpdir(), 'metis-llama-request-timeout-'))
    const destination = join(scratch, 'llama.zip')

    try {
      const outcome = await settleDownload(
        download(url, destination, {
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
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it('bounds a response body that starts and then stalls, without confusing it for header timeout', async () => {
    let requests = 0
    const { server, sockets, url } = await startServer((_request, response) => {
      requests += 1
      response.writeHead(200, { 'content-length': '2' })
      response.flushHeaders()
      response.write('x') // Start the body, then leave it incomplete and idle.
    })
    const scratch = mkdtempSync(join(tmpdir(), 'metis-llama-idle-timeout-'))
    const destination = join(scratch, 'llama.zip')

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
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})
