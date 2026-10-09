import { readFileSync } from 'node:fs'
import type { ClientRequest } from 'node:http'
import { Agent, get, type RequestOptions } from 'node:https'
import type { Socket } from 'node:net'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

interface ResponsePort {
  statusCode?: number
  headers: { location?: string }
  resume(): unknown
}

interface RequestPort {
  setTimeout(milliseconds: number, callback: () => void): unknown
  on(event: 'error', callback: (error: Error) => void): unknown
  destroy(error: Error): unknown
}

type ResponseCallback = (response: ResponsePort) => void
type GetPort = (
  url: string,
  optionsOrCallback: RequestOptions | ResponseCallback,
  callback?: ResponseCallback
) => RequestPort
type FetchStream = (url: string, redirectsLeft?: number) => Promise<ResponsePort>
type LookupCallback = Parameters<NonNullable<RequestOptions['lookup']>>[2]

const source = readFileSync(new URL('./provision-electron-dist.mjs', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
const functionPattern =
  /^function fetchStream\(url, redirectsLeft = 5\) \{[\s\S]*?^\}\n(?=\nasync function fetchText)/gm
const functionMatches = [...source.matchAll(functionPattern)]
const timeoutMatches = [...source.matchAll(/^const REQUEST_TIMEOUT_MS = ([\d_]+)$/gm)]
const constructor = 'httpsGet(url, { timeout: REQUEST_TIMEOUT_MS }, (res) => {'
const URL_FIXTURE = 'https://metis-timeout.invalid/SHASUMS256.txt'

function loadFetch(httpsGet: GetPort, legacy = false): FetchStream {
  if (functionMatches.length !== 1 || timeoutMatches.length !== 1) throw new Error('Unexpected provisioner boundaries')
  const current = functionMatches[0][0]
  if (current.split(constructor).length !== 2) throw new Error('Expected one constructor timeout argument')
  const functionSource = legacy ? current.replace(constructor, 'httpsGet(url, (res) => {') : current
  const fetch: FetchStream = runInNewContext(`(${functionSource})`, {
    httpsGet,
    REQUEST_TIMEOUT_MS: Number(timeoutMatches[0][1].replaceAll('_', '')),
    URL
  })
  return fetch
}

function invocation(optionsOrCallback: RequestOptions | ResponseCallback, callback?: ResponseCallback) {
  if (typeof optionsOrCallback === 'function') return { options: {}, callback: optionsOrCallback }
  if (!callback) throw new Error('Missing response callback')
  return { options: optionsOrCallback, callback }
}

async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Owned fixture ${label} deadline`)), 2_000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function observeConnectingSocket(legacy: boolean) {
  const agent = new Agent({ keepAlive: true, timeout: 5_000 })
  const cancellation = new Error('Owned withheld-lookup fixture cancelled')
  const requestErrors: Error[] = []
  const lookupHosts: string[] = []
  let request: ClientRequest | undefined
  let socket: Socket | undefined
  let heldLookup: LookupCallback | undefined
  let lookupSettled = 0
  let requestClosed: Promise<void> | undefined
  let socketClosed: Promise<void> | undefined
  let observe: (value: { connecting: boolean; socketTimeout: number | undefined; requestTimeout: unknown }) => void
  const observation = new Promise<{
    connecting: boolean
    socketTimeout: number | undefined
    requestTimeout: unknown
  }>((resolve) => {
    observe = resolve
  })
  const realGet: GetPort = (url, optionsOrCallback, callback) => {
    const call = invocation(optionsOrCallback, callback)
    request = get(
      url,
      {
        ...call.options,
        agent,
        lookup: (hostname, _options, complete) => {
          lookupHosts.push(hostname)
          heldLookup = complete
        }
      },
      call.callback
    )
    const ownedRequest = request
    requestClosed = new Promise((resolve) => ownedRequest.once('close', resolve))
    ownedRequest.once('error', (error) => requestErrors.push(error))
    ownedRequest.once('socket', (ownedSocket) => {
      socket = ownedSocket
      socketClosed = new Promise((resolve) => ownedSocket.once('close', () => resolve()))
      observe({
        connecting: ownedSocket.connecting,
        socketTimeout: ownedSocket.timeout,
        requestTimeout: Reflect.get(ownedRequest, 'timeout')
      })
    })
    return ownedRequest
  }
  const fetch = loadFetch(realGet, legacy)
  const outcome = fetch(URL_FIXTURE).then(
    (response) => ({ response, error: undefined }),
    (error: unknown) => ({ response: undefined, error })
  )
  let observed: Awaited<typeof observation>
  try {
    observed = await bounded(observation, 'observation')
  } finally {
    request?.destroy(cancellation)
    if (heldLookup) {
      const complete = heldLookup
      heldLookup = undefined
      lookupSettled += 1
      complete(cancellation, '', 0)
    }
    agent.destroy()
    await bounded(Promise.all([outcome, requestClosed, socketClosed]), 'cleanup')
  }
  return {
    observed,
    outcome: await outcome,
    cancellation,
    requestErrors,
    lookupHosts,
    lookupSettled,
    requestDestroyed: request?.destroyed,
    socketDestroyed: socket?.destroyed
  }
}

class FixtureRequest implements RequestPort {
  timeoutMs?: number
  timeoutCallback?: () => void
  errors: Array<(error: Error) => void> = []
  destroyedWith: Error[] = []

  setTimeout(milliseconds: number, callback: () => void) {
    this.timeoutMs = milliseconds
    this.timeoutCallback = callback
    return this
  }

  on(_event: 'error', callback: (error: Error) => void) {
    this.errors.push(callback)
    return this
  }

  emitError(error: Error) {
    for (const callback of this.errors) callback(error)
  }

  destroy(error: Error) {
    this.destroyedWith.push(error)
    this.emitError(error)
    return this
  }
}

function transportFixture() {
  const calls: Array<{
    url: string
    options: RequestOptions
    callback: ResponseCallback
    request: FixtureRequest
  }> = []
  const fetch = loadFetch((url, optionsOrCallback, callback) => {
    const call = invocation(optionsOrCallback, callback)
    const request = new FixtureRequest()
    calls.push({ url, ...call, request })
    return request
  })
  function respond(index: number, statusCode?: number, location?: string) {
    const response = {
      statusCode,
      headers: { location },
      drains: 0,
      resume() {
        this.drains += 1
      }
    }
    calls[index].callback(response)
    return response
  }
  return { calls, fetch, respond }
}

describe('Electron provisioner request timeout', () => {
  it('extracts exactly the production function and its unchanged 60-second policy', () => {
    expect(functionMatches).toHaveLength(1)
    expect(timeoutMatches).toHaveLength(1)
    expect(Number(timeoutMatches[0][1].replaceAll('_', ''))).toBe(60_000)
    expect(functionMatches[0][0].split(constructor)).toHaveLength(2)
  })

  it('configures the real connecting socket before lookup completes, unlike the exact legacy control', async () => {
    const current = await observeConnectingSocket(false)
    const legacy = await observeConnectingSocket(true)

    expect(current.observed).toEqual({ connecting: true, socketTimeout: 60_000, requestTimeout: 60_000 })
    expect(legacy.observed).toEqual({ connecting: true, socketTimeout: 5_000, requestTimeout: undefined })
    for (const result of [current, legacy]) {
      expect(result.lookupHosts).toEqual(['metis-timeout.invalid'])
      expect(result.lookupSettled).toBe(1)
      expect(result.outcome.error).toBe(result.cancellation)
      expect(result.outcome.response).toBeUndefined()
      expect(result.requestErrors).toEqual([result.cancellation])
      expect(result.requestDestroyed).toBe(true)
      expect(result.socketDestroyed).toBe(true)
    }
  })

  it('resolves the exact 200 response with both constructor and handler timeouts', async () => {
    const fixture = transportFixture()
    const result = fixture.fetch(URL_FIXTURE)
    const response = fixture.respond(0, 200)

    await expect(result).resolves.toBe(response)
    expect(fixture.calls).toHaveLength(1)
    expect(fixture.calls[0].options).toEqual({ timeout: 60_000 })
    expect(fixture.calls[0].request.timeoutMs).toBe(60_000)
    expect(response.drains).toBe(0)
  })

  it('preserves the timeout on relative and absolute redirect hops and drains redirect responses', async () => {
    const fixture = transportFixture()
    const result = fixture.fetch(URL_FIXTURE)
    const first = fixture.respond(0, 302, '/next')
    const second = fixture.respond(1, 307, 'https://metis-assets.invalid/checksums')
    const final = fixture.respond(2, 200)

    await expect(result).resolves.toBe(final)
    expect(fixture.calls.map((call) => call.url)).toEqual([
      URL_FIXTURE,
      'https://metis-timeout.invalid/next',
      'https://metis-assets.invalid/checksums'
    ])
    expect(fixture.calls.map((call) => call.options)).toEqual([
      { timeout: 60_000 },
      { timeout: 60_000 },
      { timeout: 60_000 }
    ])
    expect(fixture.calls.map((call) => call.request.timeoutMs)).toEqual([60_000, 60_000, 60_000])
    expect([first.drains, second.drains, final.drains]).toEqual([1, 1, 0])
  })

  it('rejects an exhausted redirect budget without constructing another request', async () => {
    const fixture = transportFixture()
    const result = fixture.fetch(URL_FIXTURE, 0)
    const response = fixture.respond(0, 302, '/next')

    await expect(result).rejects.toThrow(`too many redirects for ${URL_FIXTURE}`)
    expect(fixture.calls).toHaveLength(1)
    expect(response.drains).toBe(1)
  })

  it('retains the default five-redirect limit', async () => {
    const fixture = transportFixture()
    const result = fixture.fetch(URL_FIXTURE)
    const responses = []
    for (let index = 0; index <= 5; index += 1) responses.push(fixture.respond(index, 302, '/next'))

    await expect(result).rejects.toThrow('too many redirects')
    expect(fixture.calls).toHaveLength(6)
    expect(responses.map((response) => response.drains)).toEqual([1, 1, 1, 1, 1, 1])
  })

  it('rejects missing or non-200 status codes and drains their responses', async () => {
    for (const status of [undefined, 302, 403, 500]) {
      const fixture = transportFixture()
      const result = fixture.fetch(URL_FIXTURE)
      const response = fixture.respond(0, status)

      await expect(result).rejects.toThrow(`HTTP ${status ?? 0} for ${URL_FIXTURE}`)
      expect(response.drains).toBe(1)
      expect(fixture.calls).toHaveLength(1)
    }
  })

  it('propagates the original request error without retrying', async () => {
    const fixture = transportFixture()
    const error = new Error('Synthetic request failure')
    const result = fixture.fetch(URL_FIXTURE)
    fixture.calls[0].request.emitError(error)

    await expect(result).rejects.toBe(error)
    expect(fixture.calls).toHaveLength(1)
  })

  it('destroys and rejects timed-out requests with the existing error without retrying', async () => {
    const fixture = transportFixture()
    const result = fixture.fetch(URL_FIXTURE)
    const request = fixture.calls[0].request
    if (!request.timeoutCallback) throw new Error('Missing timeout handler')
    request.timeoutCallback()

    await expect(result).rejects.toThrow(`request timeout for ${URL_FIXTURE}`)
    expect(request.destroyedWith).toHaveLength(1)
    expect(request.destroyedWith[0].message).toBe(`request timeout for ${URL_FIXTURE}`)
    expect(request.timeoutMs).toBe(60_000)
    expect(fixture.calls).toHaveLength(1)
  })
})
