import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { get as httpGet, createServer, type RequestListener, type Server } from 'node:http'
import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { download, extractArchive } from './fetch-llama-server.mjs'

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

// Miniature stand-ins for the real release assets, both written by bsdtar (libarchive 3.8.1): a flat-ish
// .zip like the two win assets, and a .tar.gz like the mac asset. Each carries a llama-server binary and
// one shared library, which is all extractRuntime() ever keeps.
const WIN_ZIP_FIXTURE =
  'UEsDBBQAAAAAACZmBV0AAAAAAAAAAAAAAAAMACAAbGxhbWEtYjk5NTcvdXgLAAEEAAAAAAQAAAAAVVQNAAeIaXNqiGlzaohpc2pQ' +
  'SwMEFAAIAAgAJmYFXQAAAAAAAAAAAAAAABQAIABsbGFtYS1iOTk1Ny9nZ21sLmRsbHV4CwABBAAAAAAEAAAAAFVUDQAHiGlzaohp' +
  'c2qIaXNq841KT8/NUSjOSCxKTVHIyUxSoDYfAFBLBwhKEsFqFgAAAGIAAABQSwMEFAAIAAgAJmYFXQAAAAAAAAAAAAAAABkAIABs' +
  'bGFtYS1iOTk1Ny9sbGFtYS1jbGkuZXhldXgLAAEEAAAAAAQAAAAAVVQNAAeIaXNqiGlzaohpc2rzjVJIySxOTixKSU1RSK1IzC3I' +
  'SVVIysxLLKoEAFBLBwiXe+PoHQAAABsAAABQSwMEFAAIAAgAJmYFXQAAAAAAAAAAAAAAABwAIABsbGFtYS1iOTk1Ny9sbGFtYS1z' +
  'ZXJ2ZXIuZXhldXgLAAEEAAAAAAQAAAAAVVQNAAeIaXNqiGlzaohpc2rzjcrJScxN1C1OLSpLLVIoSKzMyU9MURiEggBQSwcIJpub' +
  'RRsAAACqAAAAUEsDBBQAAAAAACZmBV0AAAAAAAAAAAAAAAAPACAAbGxhbWEtYjk5NTcvenovdXgLAAEEAAAAAAQAAAAAVVQNAAeI' +
  'aXNqiGlzaohpc2pQSwMEFAAIAAgAJmYFXQAAAAAAAAAAAAAAABcAIABsbGFtYS1iOTk1Ny96ei9ldmlsLnR4dHV4CwABBAAAAAAE' +
  'AAAAAFVUDQAHiGlzaohpc2qIaXNqKylKLEstKk7MUSgoyk9KBQBQSwcIdWd2FBEAAAAPAAAAUEsBAhQDFAAAAAAAJmYFXQAAAAAA' +
  'AAAAAAAAAAwAGAAAAAAAAAAAAP9BAAAAAGxsYW1hLWI5OTU3L3V4CwABBAAAAAAEAAAAAFVUBQABiGlzalBLAQIUAxQACAAIACZm' +
  'BV1KEsFqFgAAAGIAAAAUABgAAAAAAAAAAAC2gUoAAABsbGFtYS1iOTk1Ny9nZ21sLmRsbHV4CwABBAAAAAAEAAAAAFVUBQABiGlz' +
  'alBLAQIUAxQACAAIACZmBV2Xe+PoHQAAABsAAAAZABgAAAAAAAAAAAD/gcIAAABsbGFtYS1iOTk1Ny9sbGFtYS1jbGkuZXhldXgL' +
  'AAEEAAAAAAQAAAAAVVQFAAGIaXNqUEsBAhQDFAAIAAgAJmYFXSabm0UbAAAAqgAAABwAGAAAAAAAAAAAAP+BRgEAAGxsYW1hLWI5' +
  'OTU3L2xsYW1hLXNlcnZlci5leGV1eAsAAQQAAAAABAAAAABVVAUAAYhpc2pQSwECFAMUAAAAAAAmZgVdAAAAAAAAAAAAAAAADwAY' +
  'AAAAAAAAAAAA/0HLAQAAbGxhbWEtYjk5NTcvenovdXgLAAEEAAAAAAQAAAAAVVQFAAGIaXNqUEsBAhQDFAAIAAgAJmYFXXVndhQR' +
  'AAAADwAAABcAGAAAAAAAAAAAALaBGAIAAGxsYW1hLWI5OTU3L3p6L2V2aWwudHh0dXgLAAEEAAAAAAQAAAAAVVQFAAGIaXNqUEsF' +
  'BgAAAAAGAAYAHwIAAI4CAAAAAA=='
const MAC_TARGZ_FIXTURE =
  'H4sIAMVpc2oAA+2TWw6DIBBFXcpsoC1QYOJyoBpjgm2jtYm7r9ofo31ZfKTpnB9eCQwcrnMmMxsbhgp3wUwwxhARmram394HXIm9' +
  '1FoiU8A45wwDUHMV1KUsLiavS/Hdp3+5H8F1/NsyddEMv2C8fyGYJv9LMPRv0+PEf+AL/6jI/yI89u9SmySZ20ZV3fM+o34PrfUL' +
  '/yh7/pUUPABvJ5/w5/4zc4BGNbSqYdRw7doJf57kv50t4vwa5/5nvMs/l4P8CxSU/yVoIt21DWdTuZOJYMKFte9IEARBDLkBO5LV' +
  'pwASAAA='

// win32-only: on macOS/Linux extractArchive deliberately still calls the system `tar`, which PATH is the
// correct way to find.
const winOnly = process.platform === 'win32' ? describe : describe.skip

winOnly('Windows archive extraction is PATH-independent', () => {
  // Node resolves a bare command name through PATH ONLY — libuv does not fall back to System32 the way a
  // raw CreateProcess would (verified: with PATH emptied, execFileSync('tar', …) fails ENOENT). So
  // emptying PATH is a faithful stand-in for the real failure: a build shell whose PATH reaches Git for
  // Windows' GNU tar (which cannot read a .zip, and reads the leading `D:` of the archive path as a
  // remote host) instead of System32's bsdtar. Extraction must not care either way.
  function withoutPath<T>(run: () => T): T {
    const original = process.env.PATH
    process.env.PATH = ''
    try {
      return run()
    } finally {
      if (original === undefined) delete process.env.PATH
      else process.env.PATH = original
    }
  }

  it('extracts a .zip release asset with no tar reachable through PATH', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'metis-llama-extract-zip-'))
    const archive = join(scratch, 'llama-b9957-bin-win-cpu-x64.zip')
    writeFileSync(archive, Buffer.from(WIN_ZIP_FIXTURE, 'base64'))
    // extractRuntime() creates the destination before calling in; mirror that.
    const destination = join(scratch, 'out')
    mkdirSync(destination, { recursive: true })

    try {
      withoutPath(() => extractArchive(archive, destination))

      const binary = join(destination, 'llama-b9957', 'llama-server.exe')
      expect(existsSync(binary)).toBe(true)
      expect(readFileSync(binary, 'utf8')).toBe('MZ' + 'llama-server payload '.repeat(8))
      expect(existsSync(join(destination, 'llama-b9957', 'ggml.dll'))).toBe(true)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it('extracts a .tar.gz release asset through the absolute System32 bsdtar, not PATH', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'metis-llama-extract-targz-'))
    const archive = join(scratch, 'llama-b9957-bin-macos-arm64.tar.gz')
    writeFileSync(archive, Buffer.from(MAC_TARGZ_FIXTURE, 'base64'))
    const destination = join(scratch, 'out')
    mkdirSync(destination, { recursive: true })

    try {
      withoutPath(() => extractArchive(archive, destination))

      expect(existsSync(join(destination, 'llama-b9957', 'build', 'bin', 'llama-server'))).toBe(true)
      expect(existsSync(join(destination, 'llama-b9957', 'build', 'bin', 'libggml.dylib'))).toBe(true)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})

describe('llama-server archive download timeouts', () => {
  it('resolves a normal completed response after the socket has closed', async () => {
    const payload = Buffer.from('llama archive fixture')
    const { server, sockets, url } = await startServer((_request, response) => {
      response.writeHead(200, { 'content-length': String(payload.length) })
      response.end(payload)
    })
    const scratch = mkdtempSync(join(tmpdir(), 'metis-llama-complete-download-'))
    const destination = join(scratch, 'llama.zip')

    try {
      const outcome = await settleDownload(
        download(url, destination, {
          requestGet: httpGet,
          requestTimeoutMs: 5_000,
          responseIdleTimeoutMs: 500,
          maxAttempts: 1
        })
      )

      expect(outcome.kind).toBe('resolved')
      expect(existsSync(destination)).toBe(true)
    } finally {
      await stopServer(server, sockets)
      rmSync(scratch, { recursive: true, force: true })
    }
  })

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
