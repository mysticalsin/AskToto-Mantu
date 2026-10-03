/** Local HTTP fixture server for the speech-pack tests. Loopback only; never imported by production code. */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FixtureServer {
  base: string
  requests: IncomingMessage[]
  close(): Promise<void>
}

export type Handler = (req: IncomingMessage, res: ServerResponse, index: number) => void

export async function serve(handler: Handler): Promise<FixtureServer> {
  const requests: IncomingMessage[] = []
  const server = createServer((req, res) => handler(req, res, requests.push(req) - 1))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

export interface RangeOptions {
  etag?: string
  ignoreRange?: boolean
  /** Send this many bytes of the first response, then drop the connection. */
  cutFirstAt?: number
  /** Transform the body served to request number `index`. */
  mutate?: (body: Buffer, index: number) => Buffer
}

/** Serves `body` with strong-ETag Range / If-Range semantics. */
export function rangeHandler(body: Buffer, o: RangeOptions = {}): Handler {
  const etag = o.etag ?? '"v1"'
  return (req, res, index) => {
    const wanted = /^bytes=(\d+)-$/.exec(req.headers.range ?? '')
    const resume = wanted !== null && !o.ignoreRange && req.headers['if-range'] === etag
    const start = resume ? Number(wanted?.[1]) : 0
    const payload = o.mutate ? o.mutate(body, index) : body
    const slice = payload.subarray(start)
    res.statusCode = resume ? 206 : 200
    res.setHeader('content-type', 'application/octet-stream')
    res.setHeader('etag', etag)
    res.setHeader('content-length', String(slice.length))
    if (resume) res.setHeader('content-range', `bytes ${start}-${payload.length - 1}/${payload.length}`)
    if (index === 0 && o.cutFirstAt !== undefined) {
      res.write(slice.subarray(0, o.cutFirstAt))
      setTimeout(() => res.destroy(), 20)
      return
    }
    res.end(slice)
  }
}
