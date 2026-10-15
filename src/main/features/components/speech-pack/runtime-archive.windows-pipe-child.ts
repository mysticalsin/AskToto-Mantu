import assert from 'node:assert/strict'
import { open, type FileHandle } from 'node:fs/promises'
import net, { type Server, type Socket } from 'node:net'
import { once } from 'node:events'

type Result = {
  kind: 'success'
  blockingReadWithheld: true
  blockingReadReleased: true
  controlByte: 0x5a
  refusal: 'RUNTIME_ARCHIVE_SHAPE_MISMATCH'
  payloadBytes: 0
}

type Message = Result | { kind: 'failure'; reason: string }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 5_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: deadline exceeded`)), milliseconds)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function run(endpoint: string): Promise<Result> {
  const archiveModule = await import(new URL('./runtime-archive.ts', import.meta.url).href)
  const server: Server = net.createServer()
  const sockets: Socket[] = []
  const closeWaiters: Array<Promise<void>> = []
  const connectionWaiters: Array<ReturnType<typeof deferred<Socket>>> = []
  const bytesReceived = new WeakMap<Socket, number>()
  const nextConnection = (): Promise<Socket> => {
    const waiter = deferred<Socket>()
    connectionWaiters.push(waiter)
    void waiter.promise.catch(() => undefined)
    return waiter.promise
  }
  server.on('connection', (socket) => {
    sockets.push(socket)
    bytesReceived.set(socket, 0)
    socket.on('data', (chunk: Buffer) => {
      bytesReceived.set(socket, (bytesReceived.get(socket) ?? 0) + chunk.byteLength)
    })
    closeWaiters.push(new Promise((resolve) => socket.once('close', resolve)))
    connectionWaiters.shift()?.resolve(socket)
  })

  let controlHandle: FileHandle | undefined
  let serverIsListening = false
  try {
    server.listen(endpoint)
    await bounded(
      once(server, 'listening').then(() => undefined),
      'named pipe listen'
    )
    serverIsListening = true

    const controlConnected = nextConnection()
    controlHandle = await bounded(open(endpoint, 'r'), 'open positive-control pipe')
    const controlSocket = await bounded(controlConnected, 'accept positive-control pipe')
    const stat = await controlHandle.stat({ bigint: true })
    assert.equal(stat.isFile(), false, 'named-pipe descriptor must be nonregular')

    const buffer = Buffer.alloc(1)
    const controlRead = controlHandle.read(buffer, 0, 1, null).then(({ bytesRead }) => ({ bytesRead, buffer }))
    const observation = await Promise.race([
      controlRead.then(() => 'read-settled' as const),
      new Promise<'withheld'>((resolve) => setTimeout(() => resolve('withheld'), 250))
    ])
    assert.equal(observation, 'withheld', 'one-byte pipe read remains pending while server withholds data')
    assert.equal(controlSocket.write(Buffer.from([0x5a])), true, 'positive-control byte must be accepted')
    const readResult = await bounded(controlRead, 'settle positive-control read')
    assert.equal(readResult.bytesRead, 1)
    assert.equal(readResult.buffer[0], 0x5a)
    await controlHandle.close()
    controlHandle = undefined
    await bounded(closeWaiters[0], 'positive-control server connection close')

    const shapeConnected = nextConnection()
    const shapePromise = archiveModule.hashPinnedArchive(endpoint, 1)
    const shapeSocket = await bounded(shapeConnected, 'accept archive-shape pipe')
    let shapeError: unknown
    try {
      await bounded(shapePromise, 'production archive pipe refusal')
    } catch (error) {
      shapeError = error
    }
    assert.ok(shapeError instanceof Error)
    assert.equal(shapeError.message, 'RUNTIME_ARCHIVE_SHAPE_MISMATCH')
    await bounded(closeWaiters[1], 'archive-shape server connection close')
    assert.equal(bytesReceived.get(shapeSocket), 0, 'archive shape refusal must precede payload bytes')

    await bounded(
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
      'close owned named-pipe server'
    )
    serverIsListening = false
    await bounded(
      Promise.all(closeWaiters).then(() => undefined),
      'settle owned named-pipe connections'
    )
    assert.equal(sockets.length, 2)
    return {
      kind: 'success',
      blockingReadWithheld: true,
      blockingReadReleased: true,
      controlByte: 0x5a,
      refusal: 'RUNTIME_ARCHIVE_SHAPE_MISMATCH',
      payloadBytes: 0
    }
  } catch (error) {
    // A failed child is immediately terminated and joined by its parent. The process boundary
    // releases any Windows pipe handles or reads that Node cannot reliably cancel in-process.
    throw error
  } finally {
    if (controlHandle) await controlHandle.close().catch(() => undefined)
    for (const socket of sockets) socket.destroy()
    if (serverIsListening) {
      await new Promise<void>((resolve) => {
        try {
          server.close(() => resolve())
        } catch {
          resolve()
        }
      })
    }
    for (const waiter of connectionWaiters.splice(0))
      waiter.reject(new Error('owned named-pipe connection wait cancelled during child cleanup'))
  }
}

function send(message: Message): void {
  if (!process.send) {
    process.exitCode = 1
    return
  }
  process.send(message, (error) => {
    if (error) process.exitCode = 1
    process.disconnect()
  })
}

const endpoint = process.argv[2]
if (!endpoint) send({ kind: 'failure', reason: 'named-pipe endpoint argument is missing' })
else {
  void run(endpoint).then(
    (result) => send(result),
    (error: unknown) =>
      send({
        kind: 'failure',
        reason: error instanceof Error ? error.message.slice(0, 300) : 'named-pipe operation failed'
      })
  )
}
