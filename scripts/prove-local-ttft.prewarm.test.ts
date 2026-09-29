import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { prewarmCall } from './prove-local-ttft.mjs'

let server: Server | undefined

afterEach(async () => {
  server?.closeAllConnections()
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()))
  server = undefined
})

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler)
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}

describe('prove-local-ttft prewarm', () => {
  it('reports a request that outlives the timeout as a measured timeout, not an exception', async () => {
    const baseUrl = await listen(() => {
      // never answers
    })

    const result = (await prewarmCall(baseUrl, 'key', [], 100)) as Record<string, unknown> & { ms: number }

    expect(result).toMatchObject({ timedOut: true, timeoutMs: 100 })
    expect(result.ms).toBeGreaterThanOrEqual(90)
  })

  it('returns the measured latency and timings when the server answers in time', async () => {
    const baseUrl = await listen((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ timings: { prompt_n: 12 } }))
    })

    const result = (await prewarmCall(baseUrl, 'key', [], 5_000)) as Record<string, unknown>


    expect(result.timedOut).toBeUndefined()
    expect(result.timings).toEqual({ prompt_n: 12 })
  })
})
