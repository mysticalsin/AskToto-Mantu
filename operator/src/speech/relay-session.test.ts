import { describe, expect, it, vi } from 'vitest'
import { hmacHex } from '../hmac'
import { createSpeechStreamBudget } from './limits'
import { SpeechSessionDurableObject } from './relay-session'

function state() {
  return {
    storage: {
      async get() {
        return undefined
      },
      async put() {},
      async setAlarm() {},
      async getAlarm() {
        return null
      }
    },
    async blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      return callback()
    }
  }
}

function bindTestStream(
  object: SpeechSessionDurableObject,
  shared: Record<string, unknown>,
  client: WebSocket,
  upstream: WebSocket
): { attachment(socket: WebSocket): Record<string, unknown> | null } {
  const internals = object as unknown as {
    liveStreams: Map<string, Record<string, unknown>>
    bindSocket(socket: WebSocket, streamId: string, role: 'client' | 'upstream'): void
    attachment(socket: WebSocket): Record<string, unknown> | null
  }
  internals.liveStreams.set(String(shared.streamId), shared)
  internals.bindSocket(client, String(shared.streamId), 'client')
  internals.bindSocket(upstream, String(shared.streamId), 'upstream')
  return internals
}

function fakeSocket() {
  return {
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  } as unknown as WebSocket & { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
}

function eventSocket() {
  const listeners = new Map<string, Set<(event: Record<string, unknown>) => void>>()
  const socket = {
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn((type: string, listener: (event: Record<string, unknown>) => void) => {
      const registered = listeners.get(type) ?? new Set()
      registered.add(listener)
      listeners.set(type, registered)
    }),
    removeEventListener: vi.fn()
  }
  return {
    socket: socket as unknown as WebSocket & { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> },
    dispatch(type: string, event: Record<string, unknown>) {
      for (const listener of listeners.get(type) ?? []) listener(event)
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('speech session Durable Object internal boundary', () => {
  it('rejects unsigned and stale internal commands before any upstream call', async () => {
    const upstream = vi.fn(async () => new Response(null, { status: 101 }))
    const secret = 'synthetic-internal-secret'
    const object = new SpeechSessionDurableObject(state(), {
      OPERATOR_INGEST_SECRET: secret,
      SPEECH_UPSTREAM_FETCH: upstream as typeof fetch
    } as never)
    const unsigned = await object.fetch(
      new Request('https://speech-session.internal/open', {
        method: 'POST',
        body: JSON.stringify({ operation: 'open-track' })
      })
    )
    expect(unsigned.status).toBe(401)
    const body = '{}'
    const staleTs = String(Date.now() - 60_000)
    const stale = await object.fetch(
      new Request('https://speech-session.internal/open', {
        method: 'POST',
        body,
        headers: {
          'x-metis-speech-internal-ts': staleTs,
          'x-metis-speech-internal-sig': await hmacHex(secret, `${staleTs}\n${body}`)
        }
      })
    )
    expect(stale.status).toBe(401)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('rejects a correctly signed command with an unknown operation before using D1 or transport', async () => {
    const upstream = vi.fn(async () => new Response(null, { status: 101 }))
    const secret = 'synthetic-internal-secret'
    const object = new SpeechSessionDurableObject(state(), {
      OPERATOR_INGEST_SECRET: secret,
      SPEECH_UPSTREAM_FETCH: upstream as typeof fetch
    } as never)
    const body = JSON.stringify({ operation: 'unknown' })
    const ts = String(Date.now())
    const response = await object.fetch(
      new Request('https://speech-session.internal/other', {
        method: 'POST',
        body,
        headers: {
          'x-metis-speech-internal-ts': ts,
          'x-metis-speech-internal-sig': await hmacHex(secret, `${ts}\n${body}`)
        }
      })
    )
    expect(response.status).toBe(404)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('keeps client and provider roles separate while forwarding results and settles only on provider close', async () => {
    const now = Date.now()
    const common = {
      streamId: 'stream-1',
      sessionId: 'session-1',
      routeEvidenceId: 'evidence-1',
      captureGeneration: 1,
      streamEpoch: 1,
      track: 'microphone' as const,
      deadlineAt: now + 30_000,
      authorizedUntil: now + 10_000,
      budget: createSpeechStreamBudget(now, now + 30_000),
      finishQueued: false,
      finishRequested: false,
      finishRequestedAt: null,
      audioDrained: false,
      providerCompleteAt: null,
      stopRequested: false,
      stopReason: null,
      stopDeadlineAt: null,
      closeControlSent: false,
      upstreamCloseRequested: false,
      closeConfirmed: false,
      lastSequence: 0,
      segmentStartMs: -1,
      segmentIndex: 0,
      segmentRevision: 0,
      segmentStates: new Map()
    }
    const client = fakeSocket()
    const upstream = fakeSocket()
    const batch = vi.fn(async () => [
      { success: true, meta: { changes: 1 } },
      { success: true, meta: { changes: 1 } },
      { success: true, meta: { changes: 1 } }
    ])
    const db = {
      prepare: () => ({
        bind() {
          return this
        },
        async run() {
          return { success: true, meta: { changes: 1 } }
        }
      }),
      batch
    }
    const objectState = state()
    const object = new SpeechSessionDurableObject(objectState as never, { DB: db } as never)
    const internals = bindTestStream(object, common, client, upstream)

    await object.webSocketMessage(
      upstream,
      JSON.stringify({
        type: 'Results',
        start: 0,
        duration: 0.2,
        is_final: false,
        channel: { alternatives: [{ transcript: 'hel' }] }
      })
    )
    await object.webSocketMessage(
      upstream,
      JSON.stringify({
        type: 'Results',
        start: 0,
        duration: 0.2,
        is_final: true,
        channel: { alternatives: [{ transcript: 'hello' }] }
      })
    )
    await object.webSocketMessage(
      upstream,
      JSON.stringify({
        type: 'Results',
        start: 0,
        duration: 0.2,
        is_final: true,
        channel: { alternatives: [{ transcript: 'changed after final' }] }
      })
    )
    expect(client.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'transcript',
        protocolVersion: 1,
        sessionId: 'session-1',
        captureGeneration: 1,
        track: 'microphone',
        streamEpoch: 1,
        sequence: 2,
        segmentIndex: 1,
        revision: 2,
        text: 'hello',
        startMs: 0,
        endMs: 200,
        final: true
      })
    )
    expect(internals.attachment(client)?.role).toBe('client')
    expect(internals.attachment(upstream)?.role).toBe('upstream')
    expect(batch).not.toHaveBeenCalled()

    await Promise.all([
      object.webSocketMessage(
        upstream,
        JSON.stringify({
          type: 'Results',
          start: 0.2,
          duration: 0.2,
          is_final: true,
          channel: { alternatives: [{ transcript: 'world' }] }
        })
      ),
      object.webSocketMessage(
        upstream,
        JSON.stringify({
          type: 'Results',
          start: 0.4,
          duration: 0.2,
          is_final: true,
          channel: { alternatives: [{ transcript: 'again' }] }
        })
      )
    ])
    const transcriptFrames = client.send.mock.calls
      .map(([value]) => (typeof value === 'string' ? JSON.parse(value) : null))
      .filter((value) => value?.type === 'transcript')
    expect(transcriptFrames.map((value) => value.sequence)).toEqual([1, 2, 3, 4])
    expect(transcriptFrames.map((value) => value.segmentIndex)).toEqual([1, 1, 2, 3])
    expect(transcriptFrames.map((value) => value.revision)).toEqual([1, 2, 1, 1])
    expect(transcriptFrames.map((value) => value.text)).toEqual(['hel', 'hello', 'world', 'again'])

    await object.webSocketMessage(client, '{"type":"finish"}')
    expect(upstream.send).toHaveBeenCalledWith('{"type":"CloseStream"}')
    expect(client.close).not.toHaveBeenCalled()
    await object.webSocketMessage(upstream, JSON.stringify({ type: 'Metadata' }))
    expect(client.send).toHaveBeenCalledTimes(4)
    expect(client.close).not.toHaveBeenCalled()

    await object.webSocketClose(upstream, 1000, '', true)
    expect(batch).toHaveBeenCalledTimes(1)
    expect(client.send).toHaveBeenLastCalledWith(
      JSON.stringify({
        type: 'terminal',
        protocolVersion: 1,
        sessionId: 'session-1',
        captureGeneration: 1,
        track: 'microphone',
        streamEpoch: 1,
        lastSequence: 4,
        closeConfirmed: true,
        tail: 'complete',
        reason: 'normal'
      })
    )
    expect(client.close).toHaveBeenCalled()
    expect(upstream.close).toHaveBeenCalled()
  })

  it('drains admitted provider completion before a late transport error after clean close', async () => {
    const now = Date.now()
    const common = {
      streamId: 'stream-close-error-order',
      sessionId: 'session-close-error-order',
      routeEvidenceId: 'evidence-1',
      captureGeneration: 1,
      streamEpoch: 1,
      track: 'microphone' as const,
      deadlineAt: now + 30_000,
      authorizedUntil: now + 10_000,
      budget: createSpeechStreamBudget(now, now + 30_000),
      finishQueued: false,
      finishRequested: false,
      finishRequestedAt: null,
      audioDrained: false,
      providerCompleteAt: null,
      stopRequested: false,
      stopReason: null,
      stopDeadlineAt: null,
      closeControlSent: false,
      upstreamCloseRequested: false,
      closeConfirmed: false,
      lastSequence: 0,
      segmentStartMs: -1,
      segmentIndex: 0,
      segmentRevision: 0,
      segmentStates: new Map()
    }
    const clientSocket = eventSocket()
    const upstreamSocket = eventSocket()
    const finalWriteEntered = deferred<void>()
    const releaseFinalWrite = deferred<void>()
    const counterWrites: Array<{ query: string; values: unknown[] }> = []
    const batchWrites: Array<Array<{ query: string; values: unknown[] }>> = []
    const db = {
      prepare(query: string) {
        return {
          bind(...values: unknown[]) {
            return {
              query,
              values,
              async run() {
                counterWrites.push({ query, values })
                if (query.includes('output_bytes = ?')) {
                  finalWriteEntered.resolve()
                  await releaseFinalWrite.promise
                }
                return { success: true, meta: { changes: 1 } }
              }
            }
          }
        }
      },
      async batch(statements: Array<{ query: string; values: unknown[] }>) {
        batchWrites.push(statements)
        return [
          { success: true, meta: { changes: 1 } },
          { success: true, meta: { changes: 1 } },
          { success: true, meta: { changes: 1 } }
        ]
      }
    }
    const object = new SpeechSessionDurableObject(state() as never, { DB: db } as never)
    const internals = bindTestStream(object, common, clientSocket.socket, upstreamSocket.socket)
    const privateObject = object as unknown as { streamTails: Map<string, Promise<void>> }

    await object.webSocketMessage(clientSocket.socket, '{"type":"finish"}')
    expect(common.finishRequested).toBe(true)
    expect(upstreamSocket.socket.send).toHaveBeenCalledWith('{"type":"CloseStream"}')

    upstreamSocket.dispatch('message', {
      data: JSON.stringify({
        type: 'Results',
        start: 0,
        duration: 0.2,
        is_final: true,
        channel: { alternatives: [{ transcript: 'final result' }] }
      })
    })
    await finalWriteEntered.promise

    // These callbacks occur in one turn while the final result's D1 counter write is pending.
    upstreamSocket.dispatch('message', { data: JSON.stringify({ type: 'Metadata' }) })
    upstreamSocket.dispatch('close', { code: 1000, reason: '', wasClean: true })
    upstreamSocket.dispatch('error', {})
    releaseFinalWrite.resolve()

    const tail = privateObject.streamTails.get(common.streamId)
    if (tail) await tail

    const messages = clientSocket.socket.send.mock.calls.map(([value]) => JSON.parse(String(value)))
    expect(messages.map((message) => message.type)).toEqual(['transcript', 'terminal'])
    expect(messages[0]).toMatchObject({ sequence: 1, revision: 1, final: true, text: 'final result' })
    expect(messages[1]).toMatchObject({
      lastSequence: 1,
      closeConfirmed: true,
      tail: 'complete',
      reason: 'normal'
    })
    expect(counterWrites.some(({ query }) => query.includes('provider_complete_at = COALESCE'))).toBe(true)
    expect(batchWrites).toHaveLength(1)
    expect(batchWrites[0][0]?.values[1]).toBe('normal')
    expect(batchWrites[0][0]?.values[7]).toBe('complete')
    expect(batchWrites[0][0]?.values[9]).toEqual(expect.any(Number))
    expect(internals.attachment(upstreamSocket.socket)?.stopRequested).toBe(false)
    expect(internals.attachment(upstreamSocket.socket)?.closeConfirmed).toBe(true)
  })

  it('stops queued audio after cancellation and bounds repeated stop controls when the provider stalls', async () => {
    const now = Date.now()
    const common = {
      streamId: 'stream-stalled',
      sessionId: 'session-stalled',
      routeEvidenceId: 'evidence-1',
      captureGeneration: 1,
      streamEpoch: 1,
      track: 'microphone' as const,
      deadlineAt: now + 30_000,
      authorizedUntil: 0,
      budget: createSpeechStreamBudget(now, now + 30_000),
      finishQueued: false,
      finishRequested: false,
      finishRequestedAt: null,
      audioDrained: false,
      providerCompleteAt: null,
      stopRequested: false,
      stopReason: null,
      stopDeadlineAt: null,
      closeControlSent: false,
      upstreamCloseRequested: false,
      closeConfirmed: false,
      lastSequence: 0,
      segmentStartMs: -1,
      segmentIndex: 0,
      segmentRevision: 0,
      segmentStates: new Map()
    }
    const client = fakeSocket()
    const upstream = fakeSocket()
    let releaseAuthority!: (value: unknown) => void
    const authority = new Promise<unknown>((resolve) => {
      releaseAuthority = resolve
    })
    const db = {
      prepare: (query: string) => ({
        bind() {
          return this
        },
        async first() {
          return query.includes('SELECT 1 AS ok') ? authority : null
        },
        async run() {
          return { success: true, meta: { changes: 1 } }
        }
      }),
      async batch() {
        return [
          { success: true, meta: { changes: 1 } },
          { success: true, meta: { changes: 1 } },
          { success: true, meta: { changes: 1 } }
        ]
      }
    }
    const object = new SpeechSessionDurableObject(state() as never, { DB: db } as never)
    bindTestStream(object, common, client, upstream)

    const queued = object.webSocketMessage(client, new ArrayBuffer(32))
    await Promise.resolve()
    await Promise.resolve()
    const internals = object as unknown as { requestStop(attachment: unknown, reason: string): Promise<void> }
    await internals.requestStop(
      (object as unknown as { attachment(socket: WebSocket): unknown }).attachment(client),
      'cancelled'
    )
    releaseAuthority({ ok: 1 })
    await queued
    expect(upstream.send).toHaveBeenCalledTimes(1)
    expect(upstream.send).toHaveBeenCalledWith('{"type":"CloseStream"}')
    expect(client.close).not.toHaveBeenCalled()

    const stream = (object as unknown as { attachment(socket: WebSocket): Record<string, unknown> }).attachment(client)
    stream.stopDeadlineAt = Date.now() - 1
    await object.alarm()
    await object.webSocketMessage(upstream, '{"type":"unexpected"}')
    await object.webSocketMessage(upstream, '{"type":"unexpected"}')
    expect(upstream.send).toHaveBeenCalledTimes(1)
    expect(upstream.close).toHaveBeenCalledTimes(1)
  })

  it('accepts provider tail during lease drain while rejecting new client audio', async () => {
    const now = Date.now()
    const common = {
      streamId: 'stream-drain',
      sessionId: 'session-drain',
      routeEvidenceId: 'evidence-1',
      captureGeneration: 1,
      streamEpoch: 1,
      track: 'microphone' as const,
      deadlineAt: now + 30_000,
      authorizedUntil: now + 10_000,
      budget: createSpeechStreamBudget(now, now + 30_000),
      finishQueued: false,
      finishRequested: false,
      finishRequestedAt: null,
      audioDrained: false,
      providerCompleteAt: null,
      stopRequested: false,
      stopReason: null,
      stopDeadlineAt: null,
      closeControlSent: false,
      upstreamCloseRequested: false,
      closeConfirmed: false,
      lastSequence: 0,
      segmentStartMs: -1,
      segmentIndex: 0,
      segmentRevision: 0,
      segmentStates: new Map()
    }
    const client = fakeSocket()
    const upstream = fakeSocket()
    const db = {
      prepare: () => ({
        bind() {
          return this
        },
        async run() {
          return { success: true, meta: { changes: 1 } }
        }
      })
    }
    const object = new SpeechSessionDurableObject(state() as never, { DB: db } as never)
    const internals = bindTestStream(object, common, client, upstream)
    await (object as unknown as { requestStop(attachment: unknown, reason: string): Promise<void> }).requestStop(
      internals.attachment(client),
      'lease-expired'
    )

    await object.webSocketMessage(client, new ArrayBuffer(16))
    expect(upstream.send).toHaveBeenCalledTimes(1)
    expect(upstream.send).toHaveBeenCalledWith('{"type":"CloseStream"}')

    await object.webSocketMessage(
      upstream,
      JSON.stringify({
        type: 'Results',
        start: 0,
        duration: 0.2,
        is_final: true,
        channel: { alternatives: [{ transcript: 'final tail' }] }
      })
    )
    expect(client.send).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(client.send.mock.calls[0][0]))).toMatchObject({
      type: 'transcript',
      text: 'final tail',
      final: true
    })

    await (object as unknown as { requestStop(attachment: unknown, reason: string): Promise<void> }).requestStop(
      internals.attachment(client),
      'cancelled'
    )
    await object.webSocketMessage(
      upstream,
      JSON.stringify({
        type: 'Results',
        start: 0.2,
        duration: 0.2,
        is_final: true,
        channel: { alternatives: [{ transcript: 'must not drain after cancel' }] }
      })
    )
    expect(client.send).toHaveBeenCalledTimes(1)
  })

  it('rejects oversized provider text before UTF-8 encoding or JSON parsing', async () => {
    const now = Date.now()
    const common = {
      streamId: 'stream-oversized-provider',
      sessionId: 'session-oversized-provider',
      routeEvidenceId: 'evidence-1',
      captureGeneration: 1,
      streamEpoch: 1,
      track: 'microphone' as const,
      deadlineAt: now + 30_000,
      authorizedUntil: now + 10_000,
      budget: createSpeechStreamBudget(now, now + 30_000),
      finishQueued: false,
      finishRequested: false,
      finishRequestedAt: null,
      audioDrained: false,
      providerCompleteAt: null,
      stopRequested: false,
      stopReason: null,
      stopDeadlineAt: null,
      closeControlSent: false,
      upstreamCloseRequested: false,
      closeConfirmed: false,
      lastSequence: 0,
      segmentStartMs: -1,
      segmentIndex: 0,
      segmentRevision: 0,
      segmentStates: new Map()
    }
    const client = fakeSocket()
    const upstream = fakeSocket()
    const object = new SpeechSessionDurableObject(state() as never, {} as never)
    bindTestStream(object, common, client, upstream)
    const encode = vi.spyOn(TextEncoder.prototype, 'encode')
    const parse = vi.spyOn(JSON, 'parse')
    try {
      await object.webSocketMessage(upstream, 'x'.repeat(64 * 1024 + 1))
      expect(encode).not.toHaveBeenCalled()
      expect(parse).not.toHaveBeenCalled()
      expect(client.send).not.toHaveBeenCalled()
      expect(upstream.send).toHaveBeenCalledWith('{"type":"CloseStream"}')
    } finally {
      encode.mockRestore()
      parse.mockRestore()
    }
  })
})
