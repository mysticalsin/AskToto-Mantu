import { createServer, get as httpGet, type RequestListener } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { downloadFile } from './download-file.mjs'

const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function startServer(handler: RequestListener) {
  const sockets = new Set<Socket>()
  const server = createServer(handler)
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/asset.tar.gz`,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  }
}

describe('downloadFile', () => {
  it('retries a transient download failure and promotes only the complete file', async () => {
    let requests = 0
    const server = await startServer((_request, response) => {
      requests += 1
      if (requests === 1) {
        response.destroy()
        return
      }
      response.writeHead(200, { 'content-length': '7' })
      response.end('node-v1')
    })
    const root = mkdtempSync(join(tmpdir(), 'metis-download-file-'))
    scratch.push(root)
    const dest = join(root, 'node.tar.gz')

    try {
      await downloadFile(server.url, dest, {
        requestGet: httpGet,
        requestTimeoutMs: 1_000,
        responseIdleTimeoutMs: 1_000,
        maxAttempts: 2,
        backoffBaseMs: 1
      })

      expect(requests).toBe(2)
      expect(readFileSync(dest, 'utf8')).toBe('node-v1')
      expect(existsSync(`${dest}.part`)).toBe(false)
    } finally {
      await server.close()
    }
  })
})
