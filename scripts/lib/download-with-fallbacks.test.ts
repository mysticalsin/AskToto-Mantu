import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { downloadWithFallbacks } from './download-with-fallbacks.mjs'

const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), 'metis-download-fallback-'))
  scratch.push(dir)
  return join(dir, 'asset.tgz')
}

function fakeGet(bodyByUrl: Record<string, string>) {
  const calls: string[] = []
  const get = (url: string, _options: unknown, callback: (response: Readable & { statusCode?: number; headers: Record<string, string> }) => void) => {
    calls.push(url)
    const req = new EventEmitter() as EventEmitter & { destroy: (error: Error) => void }
    req.destroy = (error: Error) => process.nextTick(() => req.emit('error', error))
    process.nextTick(() => {
      const body = bodyByUrl[url]
      if (body === undefined) {
        req.emit('error', Object.assign(new Error('getaddrinfo ENOTFOUND nodejs.org'), { code: 'ENOTFOUND' }))
        return
      }
      const response = Readable.from([body]) as Readable & { statusCode?: number; headers: Record<string, string> }
      response.statusCode = 200
      response.headers = {}
      callback(response)
    })
    return req
  }
  return { get, calls }
}

describe('downloadWithFallbacks', () => {
  it('uses the fallback URL when the primary host cannot be resolved', async () => {
    const dest = tempFile()
    const { get, calls } = fakeGet({ 'https://r2.nodejs.org/dist/v24.21.0/node.tar.gz': 'verified archive bytes' })

    await downloadWithFallbacks(
      ['https://nodejs.org/dist/v24.21.0/node.tar.gz', 'https://r2.nodejs.org/dist/v24.21.0/node.tar.gz'],
      dest,
      { attempts: 1, get, retryDelayMs: 0 }
    )

    expect(calls).toEqual([
      'https://nodejs.org/dist/v24.21.0/node.tar.gz',
      'https://r2.nodejs.org/dist/v24.21.0/node.tar.gz'
    ])
    expect(readFileSync(dest, 'utf8')).toBe('verified archive bytes')
  })
})
