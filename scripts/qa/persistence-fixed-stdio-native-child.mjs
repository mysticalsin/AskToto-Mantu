import fs from 'node:fs'
import path from 'node:path'
import { Socket } from 'node:net'
import {
  BASE,
  ENTRY,
  SOURCES,
  IDS,
  NAMES,
  SOCKET,
  BULK,
  MAX_PAYLOAD,
  OP,
  PHASE,
  STATES,
  assert,
  hash,
  digestText,
  exactKeys,
  jsonBytes,
  errorProjection,
  safeRuntime,
  readBounded,
  replayEventShape,
  writeAll
} from './persistence-fixed-stdio-native-evidence.mjs'

export async function runChild(caseId) {
  assert(IDS.includes(caseId), 'fixed child case required')
  const expectedName = NAMES[IDS.indexOf(caseId)]
  const env = process.env
  assert(env.METIS_N0_CASE === caseId && env.METIS_N0_NAME === expectedName, 'child provenance case mismatch')
  assert(env.METIS_N0_BASE === BASE && /^[0-9a-f]{40}$/.test(env.METIS_N0_HEAD || ''), 'child provenance source')
  const files = JSON.parse(env.METIS_N0_SOURCE_FILES || 'null')
  assert(Array.isArray(files) && files.length === SOURCES.length, 'child source roster')
  for (let i = 0; i < SOURCES.length; i++) {
    const file = files[i]
    exactKeys(file, ['path', 'blobId', 'gitSha256', 'checkoutSha256', 'projection', 'bytes'], 'child source record')
    assert(
      file.path === SOURCES[i] &&
        /^[0-9a-f]{40}$/.test(file.blobId) &&
        /^[0-9a-f]{64}$/.test(file.gitSha256) &&
        /^[0-9a-f]{64}$/.test(file.checkoutSha256),
      'child source identity'
    )
    assert(
      hash(readBounded(path.join(process.cwd(), file.path), 256 * 1024)) === file.checkoutSha256,
      'child held checkout source changed'
    )
  }
  const sourceSetSha256 = hash(Buffer.from(JSON.stringify(files)))
  assert(sourceSetSha256 === env.METIS_N0_SOURCE_SET_SHA256, 'child source-set mismatch')
  const ownHash = files[0].checkoutSha256
  assert(/^[0-9a-f]{64}$/.test(env.METIS_N0_ENTRY_GIT_SHA256 || ''), 'child Git source hash')
  const versions = safeRuntime()
  assert(versions.nodeVersion === 'v22.22.3', 'child Node version')
  assert(
    versions.platform + '-' + versions.arch === env.METIS_N0_TARGET &&
      env.METIS_N0_RUN_ID &&
      env.METIS_N0_ATTEMPT &&
      env.METIS_N0_JOB === 'fixed-stdio',
    'child run binding'
  )
  const socketBuffers = SOCKET.has(caseId) ? [Buffer.alloc(8192), Buffer.alloc(8192)] : null
  const bulkBuffer = BULK.has(caseId) ? Buffer.alloc(512 * 1024, 0xa5) : null
  let seq = 0
  let lastCommandSeq = 0
  let issuedSends = 0
  let completedSends = 0
  let finalSendCallback = false
  let finalSendState = 'unissued'
  let finalSendError = null
  let uncaughtExceptionCount = 0
  let unhandledRejectionCount = 0
  let failed = false
  let hasPrimaryFailure = false
  let primaryFailure
  const secondaryFailures = []
  const cleanupAttempted = new Set()
  function retainFailure(reason) {
    if (!hasPrimaryFailure) {
      hasPrimaryFailure = true
      primaryFailure = reason
    } else if (secondaryFailures.length < 256) secondaryFailures.push(reason)
    failed = true
    process.exitCode = 1
  }
  function childFailure(reason) {
    retainFailure(reason)
    let message
    try {
      message = (
        typeof reason?.stack === 'string' ? reason.stack : typeof reason === 'string' ? reason : String(reason)
      ).slice(0, 400)
    } catch (projectionError) {
      retainFailure(projectionError)
      message = 'unprintable child failure'
    }
    try {
      writeAll(2, Buffer.from('METIS_N0_CHILD_FAILURE ' + message + '\n'))
    } catch (logError) {
      retainFailure(logError)
    }
  }
  let finalSent = false
  let phase = 'setup'
  let pendingSend = false
  const sendQueue = []
  let queueFailed = false
  let ordinaryOverflow = false
  let nativeId = 0
  const nativePending = new Map()
  const eventHistory = []
  const publicPending = new Map()
  const sockets = {}
  const streams = {}
  const acquired = new Set()
  const closed = new Set()
  const ended = new Set()
  const streamErrors = []
  const publicTerminals = new Map()
  let gotInput = false
  let gotReverse = !SOCKET.has(caseId)
  let writeOneDone = false
  let writeOneStarted = false
  let bulkReturnedFalse = false
  let bulkReturnKnown = !BULK.has(caseId)
  let bulkCallbackDone = !BULK.has(caseId)
  let armAsked = false
  let armed = false
  let armedSeq = null
  let armFailed = false
  let sampleSent = false
  let sampleTimerArmed = false
  let sampleDeadline = null
  let goalSeen = false
  let goalRefused = false
  let peerClosedAccepted = false
  let finalAsked = false
  const commandSeen = new Set()
  const originalFs = { read: fs.read, write: fs.write, writev: fs.writev, close: fs.close }
  let settleWake = null
  const wake = () => {
    if (settleWake) settleWake()
    settleWake = null
  }

  function emitPayload(payload) {
    if (finalSent || queueFailed) {
      childFailure('application observation after final or failed queue')
      return false
    }
    let size
    try {
      size = jsonBytes(payload, MAX_PAYLOAD)
    } catch {
      size = MAX_PAYLOAD + 1
    }
    const terminal =
      ['sample', 'command-ack'].includes(payload.kind) ||
      ['stream-close', 'stream-end', 'stream-error', 'fd-check', 'fatal'].includes(payload.op) ||
      (['fulfilled', 'rejected', 'threw'].includes(payload.state) &&
        ['api-write', 'fs-read', 'fs-write', 'fs-writev', 'fs-close'].includes(payload.op)) ||
      (payload.op === 'fs-close' && payload.state === 'start') ||
      (['acquire', 'goal'].includes(payload.op) && payload.state === 'rejected') ||
      (payload.op === 'local-destroy' && payload.state === 'requested')
    const terminalReserve = Math.max(16, nativePending.size + publicPending.size + acquired.size * 3 + 6)
    if (size > MAX_PAYLOAD || sendQueue.length >= 16 || seq > 128 || (!terminal && 128 - seq < terminalReserve)) {
      seq--
      if (seq >= 128 || size > MAX_PAYLOAD || sendQueue.length >= 16) queueFailed = true
      failed = true
      if (!ordinaryOverflow) {
        ordinaryOverflow = true
        childFailure('bounded IPC queue or child record limit')
        childEntryCleanup()
      }
      return false
    }
    const wire = JSON.stringify(payload)
    assert(Buffer.byteLength(wire) === size, 'child canonical byte count')
    sendQueue.push(wire)
    pumpSend()
    return true
  }

  function event(op, endpoint, id, state, fields = {}) {
    if (goalSeen && !sampleSent && sampleDeadline !== null && performance.now() >= sampleDeadline) takeSample()
    const payload = {
      v: 1,
      kind: 'event',
      caseId,
      seq: ++seq,
      phase,
      op,
      endpoint,
      id,
      state,
      bytes: fields.bytes ?? null,
      dataSha256: fields.dataSha256 ?? null,
      result: fields.result ?? null,
      error: fields.error ?? null
    }
    assert(OP.has(op) && PHASE.has(phase) && STATES.has(state), 'child event enum')
    replayEventShape(payload, caseId, payload.seq)
    if (emitPayload(payload)) eventHistory.push(payload)
    wake()
    if (goalSeen && !sampleSent && goalPredicate()) takeSample()
    return payload
  }

  function barrier(kind) {
    const payload = { v: 1, kind, caseId, seq: ++seq, phase, lastEventSeq: seq - 1 }
    emitPayload(payload)
    wake()
  }

  function pumpSend() {
    if (pendingSend || sendQueue.length === 0 || !process.send || !process.connected) return
    pendingSend = true
    const wire = sendQueue.shift()
    issuedSends++
    try {
      process.send(wire, (error) => {
        pendingSend = false
        completedSends++
        if (error) {
          queueFailed = true
          childFailure(error)
          childEntryCleanup()
        }
        pumpSend()
        maybeFinish()
      })
    } catch (error) {
      pendingSend = false
      queueFailed = true
      childFailure(error)
      childEntryCleanup()
    }
  }

  function childEntryCleanup() {
    for (const value of Object.values(streams)) {
      if (cleanupAttempted.has(value)) continue
      cleanupAttempted.add(value)
      try {
        value.destroy()
      } catch (error) {
        childFailure(error)
      }
    }
    for (const value of Object.values(sockets)) {
      if (cleanupAttempted.has(value)) continue
      cleanupAttempted.add(value)
      try {
        value.destroy()
      } catch (error) {
        childFailure(error)
      }
    }
  }

  function observationFailed(error) {
    childFailure(error)
    childEntryCleanup()
  }

  process.on('uncaughtExceptionMonitor', (_error, origin) => {
    uncaughtExceptionCount++
    if (origin === 'unhandledRejection') unhandledRejectionCount++
  })
  process.on('exit', (code) => {
    const footer = {
      v: 1,
      kind: 'exit-footer',
      caseId,
      issuedSends,
      completedSends,
      finalSendCallback,
      finalSendState,
      finalSendError,
      uncaughtExceptionCount,
      unhandledRejectionCount,
      exitCode: code
    }
    try {
      fs.writeSync(2, 'METIS_N0_EXIT ' + JSON.stringify(footer) + '\n')
    } catch (error) {
      retainFailure(error)
    }
  })
  process.on('message', (message) => {
    try {
      assert(
        typeof message === 'string' && message.length <= MAX_PAYLOAD && Buffer.byteLength(message) <= MAX_PAYLOAD,
        'child command wire'
      )
      const command = JSON.parse(message)
      assert(JSON.stringify(command) === message, 'command must be canonical JSON')
      exactKeys(command, ['v', 'kind', 'caseId', 'seq', 'command'], 'command')
      assert(command.v === 1 && command.kind === 'command' && command.caseId === caseId, 'command binding')
      assert(
        Number.isSafeInteger(command.seq) && command.seq === lastCommandSeq + 1 && command.seq <= 12,
        'command sequence'
      )
      const allowed = [
        'begin',
        'arm',
        'goal',
        'peer-closed',
        'rescue-destroy',
        'rescue-drain',
        'rescue-input-eof',
        'finish'
      ]
      assert(allowed.includes(command.command), 'command admission')
      validateCommand(command.command)
      assert(
        emitPayload({
          v: 1,
          kind: 'command-ack',
          caseId,
          seq: ++seq,
          commandSeq: command.seq,
          command: command.command,
          phase,
          lastEventSeq: seq - 1
        }),
        'command acknowledgment admission'
      )
      lastCommandSeq = command.seq
      commandSeen.add(command.command)
      onCommand(command.command)
    } catch (error) {
      childFailure(error)
      try {
        event('fatal', 'ipc', 0, 'rejected', { error: errorProjection(error) })
      } catch (observationError) {
        childFailure(observationError)
      }
      childEntryCleanup()
    }
  })

  function nextNative(op, endpoint, bytes, callback, readOffset = 0) {
    const id = nativeId + 1
    nativeId = id
    const consumedCloses = new Set(
      eventHistory.filter((item) => item.op === 'fs-close' && item.state === 'start').map((item) => item.endpoint)
    ).size
    const ordinaryLimit = 32 - (2 - consumedCloses)
    if (id > (op === 'fs-close' ? 32 : ordinaryLimit)) {
      observationFailed(new Error('native operation cap'))
      const tracked = { id, wrapped: null, callbackThrew: false }
      tracked.wrapped = function (...args) {
        try {
          return callback.apply(this, args)
        } catch (error) {
          tracked.callbackThrew = true
          throw error
        }
      }
      return tracked
    }
    const tracked = { id, wrapped: null, callbackThrew: false }
    try {
      nativePending.set(id, { op, endpoint })
      event(op, endpoint, id, 'start', { bytes: op === 'fs-close' ? null : bytes })
      maybeArm()
      if (id === ordinaryLimit && op !== 'fs-close') {
        observationFailed(new Error('native ordinary operation reservation exhausted'))
      }
    } catch (error) {
      observationFailed(error)
    }
    const wrapped = function (...args) {
      try {
        const error = args[0] || null
        let count = null
        let dataSha256 = null
        if (op === 'fs-read' && !error && Number.isSafeInteger(args[1]) && args[1] >= 0 && Buffer.isBuffer(args[2])) {
          count = args[1]
          if (count > 0) dataSha256 = hash(args[2].subarray(readOffset, readOffset + count))
        } else if (!error && (op === 'fs-write' || op === 'fs-writev') && Number.isSafeInteger(args[1])) {
          count = args[1]
        }
        nativePending.delete(id)
        event(op, endpoint, id, error ? 'rejected' : 'fulfilled', {
          bytes: count,
          dataSha256,
          error: error ? errorProjection(error) : null
        })
        wake()
      } catch (observationError) {
        observationFailed(observationError)
      }
      try {
        return callback.apply(this, args)
      } catch (error) {
        tracked.callbackThrew = true
        throw error
      }
    }
    tracked.wrapped = wrapped
    return tracked
  }

  function fsDelegate(name, op, endpoint, args, receiver) {
    const index = args.length - 1
    const callback = args[index]
    if (typeof callback !== 'function') return originalFs[name].apply(receiver, args)
    let byteCount = Number.isSafeInteger(args[3]) ? args[3] : null
    let tracked
    try {
      if (op === 'fs-writev' && Array.isArray(args[1])) {
        byteCount = args[1].reduce((sum, item) => sum + item.byteLength, 0)
      }
      tracked = nextNative(op, endpoint, byteCount, callback, op === 'fs-read' ? args[2] : 0)
    } catch (observationError) {
      observationFailed(observationError)
      tracked = { id: nativeId, wrapped: null, callbackThrew: false }
      tracked.wrapped = function (...callbackArgs) {
        try {
          return callback.apply(this, callbackArgs)
        } catch (error) {
          tracked.callbackThrew = true
          throw error
        }
      }
    }
    args[index] = tracked.wrapped
    try {
      return originalFs[name].apply(receiver, args)
    } catch (error) {
      if (tracked.callbackThrew) throw error
      nativePending.delete(tracked.id)
      try {
        event(op, endpoint, tracked.id, 'threw', { error: errorProjection(error) })
      } catch (observationError) {
        observationFailed(observationError)
      }
      throw error
    }
  }

  const delegatedFs = {
    read(...args) {
      return fsDelegate('read', 'fs-read', 'reader3', args, this)
    },
    write(...args) {
      return fsDelegate('write', 'fs-write', 'writer4', args, this)
    },
    writev(...args) {
      return fsDelegate('writev', 'fs-writev', 'writer4', args, this)
    },
    close(...args) {
      if (typeof args.at(-1) !== 'function') return originalFs.close.apply(this, args)
      let tracked
      try {
        tracked = nextNative('fs-close', args[0] === 3 ? 'reader3' : 'writer4', 0, args.at(-1))
      } catch (observationError) {
        observationFailed(observationError)
        const callback = args.at(-1)
        tracked = { id: nativeId, wrapped: null, callbackThrew: false }
        tracked.wrapped = function (...callbackArgs) {
          try {
            return callback.apply(this, callbackArgs)
          } catch (error) {
            tracked.callbackThrew = true
            throw error
          }
        }
      }
      args[args.length - 1] = tracked.wrapped
      try {
        return originalFs.close.apply(this, args)
      } catch (error) {
        if (tracked.callbackThrew) throw error
        nativePending.delete(tracked.id)
        try {
          event('fs-close', args[0] === 3 ? 'reader3' : 'writer4', tracked.id, 'threw', {
            error: errorProjection(error)
          })
        } catch (observationError) {
          observationFailed(observationError)
        }
        throw error
      }
    }
  }

  function bindStream(stream, endpoint) {
    acquired.add(endpoint)
    event('acquire', endpoint, 0, 'fulfilled')
    stream.on('data', (buffer) => {
      const bytes = Buffer.from(buffer)
      const input = endpoint === 'reader3'
      event('peer-read', endpoint, 0, 'observed', { bytes: bytes.length, dataSha256: hash(bytes) })
      if (input && bytes.length === 1 && bytes[0] === 0x61) gotInput = true
      wake()
      maybeHandshakeWrite()
    })
    stream.on('end', () => {
      ended.add(endpoint)
      event('stream-end', endpoint, 0, 'observed')
      wake()
    })
    stream.on('error', (error) => {
      streamErrors.push({ endpoint, code: error?.code })
      event('stream-error', endpoint, 0, 'rejected', { error: errorProjection(error) })
      wake()
    })
    stream.on('close', () => {
      closed.add(endpoint)
      event('stream-close', endpoint, 0, 'observed')
      fdCheck(endpoint)
      wake()
      maybeFinish()
    })
  }

  function bindSocket(socket, endpoint) {
    acquired.add(endpoint)
    event('acquire', endpoint, 0, 'fulfilled')
    socket.on('end', () => {
      ended.add(endpoint)
      event('stream-end', endpoint, 0, 'observed')
      wake()
    })
    socket.on('error', (error) => {
      streamErrors.push({ endpoint, code: error?.code })
      event('stream-error', endpoint, 0, 'rejected', { error: errorProjection(error) })
      wake()
    })
    socket.on('close', (hadError) => {
      closed.add(endpoint)
      event('stream-close', endpoint, 0, 'observed', { result: hadError })
      fdCheck(endpoint)
      wake()
      maybeFinish()
    })
  }

  function fdCheck(endpoint) {
    const fd = endpoint === 'reader3' ? 3 : 4
    let hasError = false
    let originalError
    try {
      fs.fstatSync(fd)
    } catch (error) {
      hasError = true
      originalError = error
    }
    try {
      event('fd-check', endpoint, 0, hasError ? 'rejected' : 'observed', {
        error: hasError ? errorProjection(originalError) : null
      })
    } catch (observationError) {
      observationFailed(observationError)
    }
  }

  function constructEndpoint(endpoint, owners, create) {
    let value
    try {
      value = create()
    } catch (error) {
      try {
        event('acquire', endpoint, 0, 'rejected', { error: errorProjection(error) })
      } catch (observationError) {
        observationFailed(observationError)
      }
      throw error
    }
    owners[endpoint] = value
    return value
  }

  function acquireEndpoints() {
    if (SOCKET.has(caseId)) {
      bindSocket(
        constructEndpoint(
          'reader3',
          sockets,
          () =>
            new Socket({
              fd: 3,
              readable: true,
              writable: false,
              allowHalfOpen: false,
              onread: { buffer: socketBuffers[0], callback: (nread, buffer) => socketRead('reader3', nread, buffer) }
            })
        ),
        'reader3'
      )
      bindSocket(
        constructEndpoint(
          'writer4',
          sockets,
          () =>
            new Socket({
              fd: 4,
              readable: true,
              writable: true,
              allowHalfOpen: false,
              onread: { buffer: socketBuffers[1], callback: (nread, buffer) => socketRead('writer4', nread, buffer) }
            })
        ),
        'writer4'
      )
    } else {
      bindStream(
        constructEndpoint('reader3', streams, () =>
          fs.createReadStream('', {
            fd: 3,
            autoClose: true,
            highWaterMark: 8192,
            fs: delegatedFs
          })
        ),
        'reader3'
      )
      bindStream(
        constructEndpoint('writer4', streams, () =>
          fs.createWriteStream('', {
            fd: 4,
            autoClose: true,
            highWaterMark: 8192,
            fs: delegatedFs
          })
        ),
        'writer4'
      )
    }
  }

  function socketRead(endpoint, nread, buffer) {
    if (nread > 0) {
      const bytes = Buffer.from(buffer.subarray(0, nread))
      event('socket-read', endpoint, 0, 'observed', { bytes: nread, dataSha256: hash(bytes) })
      if (endpoint === 'reader3' && nread === 1 && buffer[0] === 0x61) gotInput = true
      if (endpoint === 'writer4' && nread === 1 && buffer[0] === 0x63) gotReverse = true
      wake()
      maybeHandshakeWrite()
    }
    return true
  }

  function maybeHandshakeWrite() {
    if (!gotInput || writeOneStarted || (!streams.writer4 && !sockets.writer4)) return
    writeOneStarted = true
    const target = streams.writer4 || sockets.writer4
    publicWrite(target, 1, Buffer.from([0x62]), () => {})
  }

  function publicWrite(target, id, bytes, callback) {
    assert((id === 1 || id === 2) && !publicPending.has(id) && !publicTerminals.has(id), 'child public write slot')
    publicPending.set(id, true)
    try {
      event('api-write', 'writer4', id, 'start', { bytes: bytes.length, dataSha256: hash(bytes) })
    } catch (error) {
      childFailure(error)
    }
    let returned
    let originalCallbackThrew = false
    const observerFailure = observationFailed
    try {
      returned = target.write(bytes, function (...args) {
        try {
          const error = args[0]
          publicPending.delete(id)
          if (id === 1) writeOneDone = !error
          if (id === 2) bulkCallbackDone = true
          publicTerminals.set(id, {
            state: error ? 'rejected' : 'fulfilled',
            code: error?.code ?? null
          })
          event('api-write', 'writer4', id, error ? 'rejected' : 'fulfilled', {
            bytes: bytes.length,
            dataSha256: hash(bytes),
            error: error ? errorProjection(error) : null
          })
          wake()
          maybeArm()
          maybeFinish()
        } catch (observationError) {
          observerFailure(observationError)
        }
        try {
          return callback?.apply(this, args)
        } catch (error) {
          originalCallbackThrew = true
          throw error
        }
      })
    } catch (error) {
      if (originalCallbackThrew) throw error
      publicPending.delete(id)
      if (id === 2) bulkCallbackDone = true
      publicTerminals.set(id, { state: 'threw', code: error?.code ?? null })
      try {
        event('api-write', 'writer4', id, 'threw', { error: errorProjection(error) })
      } catch (observationError) {
        observerFailure(observationError)
      }
      throw error
    }
    if (id === 2) {
      bulkReturnedFalse = returned === false
      bulkReturnKnown = true
    }
    try {
      event('api-write', 'writer4', id, 'observed', { result: returned })
      wake()
      maybeArm()
    } catch (observationError) {
      observerFailure(observationError)
    }
    return returned
  }

  function fsPendingRead() {
    if (SOCKET.has(caseId)) return true
    const first = eventHistory.find(
      (item) =>
        item.op === 'fs-read' &&
        item.endpoint === 'reader3' &&
        item.state === 'fulfilled' &&
        item.bytes === 1 &&
        item.dataSha256 === hash(Buffer.from([0x61]))
    )
    return Boolean(
      first &&
        eventHistory.some(
          (item) =>
            item.op === 'fs-read' &&
            item.endpoint === 'reader3' &&
            item.state === 'start' &&
            item.seq > first.seq &&
            nativePending.has(item.id)
        )
    )
  }

  function nativeBulkPending() {
    const bulk = eventHistory.find((item) => item.op === 'api-write' && item.id === 2 && item.state === 'start')
    return Boolean(
      bulk &&
        [...nativePending].some(
          ([id, item]) =>
            item.endpoint === 'writer4' &&
            ['fs-write', 'fs-writev'].includes(item.op) &&
            eventHistory.some((start) => start.id === id && start.state === 'start' && start.seq > bulk.seq)
        )
    )
  }

  function maybeArm() {
    if (!armAsked || armed || armFailed) return
    if (BULK.has(caseId) && bulkReturnKnown && (!bulkReturnedFalse || bulkCallbackDone)) {
      armFailed = true
      event('goal', 'writer4', 2, 'rejected')
      wake()
      return
    }
    if (!gotInput || !writeOneDone || !gotReverse || !acquired.has('reader3') || !acquired.has('writer4')) return
    if (!SOCKET.has(caseId) && !fsPendingRead()) return
    if (BULK.has(caseId)) {
      if (!bulkReturnedFalse || bulkCallbackDone) return
      if (!SOCKET.has(caseId) && !nativeBulkPending()) return
    }
    armed = true
    barrier('armed')
    armedSeq = seq
    wake()
  }

  function destroyOwned() {
    for (const endpoint of ['reader3', 'writer4']) {
      const item = streams[endpoint] || sockets[endpoint]
      if (!item || closed.has(endpoint)) continue
      event('local-destroy', endpoint, 0, 'requested')
      item.destroy()
    }
    wake()
  }

  function goalPredicate() {
    if (failed || goalRefused || ended.has('reader3')) return false
    const first = (op, endpoint, state) =>
      eventHistory.findIndex((item) => item.op === op && item.endpoint === endpoint && item.state === state)
    const destroyed = ['reader3', 'writer4'].every((endpoint) => first('local-destroy', endpoint, 'requested') >= 0)
    const goal = eventHistory.find((item) => item.op === 'goal' && item.state === 'start')
    const healthBeforeArm =
      armedSeq !== null &&
      ['reader3', 'writer4'].every((endpoint) =>
        eventHistory.some(
          (item) =>
            item.op === 'acquire' && item.endpoint === endpoint && item.state === 'fulfilled' && item.seq < armedSeq
        )
      ) &&
      eventHistory.some(
        (item) =>
          item.op === (SOCKET.has(caseId) ? 'socket-read' : 'peer-read') &&
          item.endpoint === 'reader3' &&
          item.bytes === 1 &&
          item.dataSha256 === hash(Buffer.from([0x61])) &&
          item.seq < armedSeq
      ) &&
      eventHistory.some(
        (item) =>
          item.op === 'api-write' &&
          item.endpoint === 'writer4' &&
          item.id === 1 &&
          item.state === 'fulfilled' &&
          item.seq < armedSeq
      ) &&
      ['start', 'observed'].every((eventState) =>
        eventHistory.some(
          (item) => item.op === 'api-write' && item.id === 1 && item.state === eventState && item.seq < armedSeq
        )
      ) &&
      (!SOCKET.has(caseId) ||
        eventHistory.some(
          (item) =>
            item.op === 'socket-read' &&
            item.endpoint === 'writer4' &&
            item.bytes === 1 &&
            item.dataSha256 === hash(Buffer.from([0x63])) &&
            item.seq < armedSeq
        ))
    const pendingAt = (start, boundary) =>
      start.seq < boundary &&
      !eventHistory.some(
        (item) =>
          item.op === start.op &&
          item.id === start.id &&
          ['fulfilled', 'rejected', 'threw'].includes(item.state) &&
          item.seq < boundary
      )
    const firstInput = eventHistory.find(
      (item) =>
        item.op === 'fs-read' &&
        item.endpoint === 'reader3' &&
        item.state === 'fulfilled' &&
        item.bytes === 1 &&
        item.dataSha256 === hash(Buffer.from([0x61]))
    )
    const destroyRows = eventHistory.filter((item) => item.op === 'local-destroy' && item.state === 'requested')
    const bulkStart = eventHistory.find((item) => item.op === 'api-write' && item.id === 2 && item.state === 'start')
    const bulkTerminal = eventHistory.find(
      (item) => item.op === 'api-write' && item.id === 2 && ['fulfilled', 'rejected', 'threw'].includes(item.state)
    )
    const requiredBoundaries = [armedSeq, goal?.seq, ...destroyRows.map((item) => item.seq)].filter(
      (value) => value !== null && value !== undefined
    )
    const readPending =
      SOCKET.has(caseId) ||
      Boolean(
        firstInput &&
          eventHistory.some(
            (start) =>
              start.op === 'fs-read' &&
              start.endpoint === 'reader3' &&
              start.state === 'start' &&
              start.seq > firstInput.seq &&
              requiredBoundaries.every((boundary) => pendingAt(start, boundary))
          )
      )
    const nativeBulkPending =
      caseId !== 'N05' ||
      requiredBoundaries.every((boundary) =>
        eventHistory.some(
          (start) =>
            ['fs-write', 'fs-writev'].includes(start.op) &&
            start.endpoint === 'writer4' &&
            start.state === 'start' &&
            bulkStart &&
            start.seq > bulkStart.seq &&
            start.seq < (bulkTerminal?.seq ?? Infinity) &&
            pendingAt(start, boundary)
        )
      )
    const bulkFalseBeforeArm =
      !BULK.has(caseId) ||
      eventHistory.some(
        (item) =>
          item.op === 'api-write' &&
          item.id === 2 &&
          item.state === 'observed' &&
          item.result === false &&
          item.seq < armedSeq
      )
    const writerDestroy = eventHistory.find(
      (item) => item.op === 'local-destroy' && item.endpoint === 'writer4' && item.state === 'requested'
    )
    const cancellation =
      caseId === 'N06' &&
      writerDestroy &&
      bulkTerminal?.state === 'rejected' &&
      bulkTerminal.seq > writerDestroy.seq &&
      ['ECANCELED', 'ERR_STREAM_DESTROYED'].includes(bulkTerminal.error?.code)
    const errorFree = eventHistory.every(
      (item) =>
        !item.error ||
        item.op === 'fd-check' ||
        (cancellation &&
          (item === bulkTerminal ||
            (item.op === 'stream-error' &&
              item.endpoint === 'writer4' &&
              item.phase === 'goal' &&
              item.seq > writerDestroy.seq &&
              item.error.code === bulkTerminal.error.code)))
    )
    if (!healthBeforeArm || !goal || !readPending || !nativeBulkPending || !bulkFalseBeforeArm || !errorFree)
      return false
    const proved = (endpoint, native) => {
      const close = first('stream-close', endpoint, 'observed')
      const badFd = eventHistory.findIndex(
        (item) => item.op === 'fd-check' && item.endpoint === endpoint && item.error?.code === 'EBADF'
      )
      const callback = native ? first('fs-close', endpoint, 'fulfilled') : -1
      const cause = first('local-destroy', endpoint, 'requested')
      const source = caseId === 'N03' || caseId === 'N04' ? -1 : cause
      const actualClose = eventHistory[close]
      return (
        close > source &&
        badFd > close &&
        (!native || (callback > source && callback < close)) &&
        (!SOCKET.has(caseId) ||
          actualClose.result === false ||
          (caseId === 'N06' &&
            endpoint === 'writer4' &&
            actualClose.result === true &&
            publicTerminals.get(2)?.state === 'rejected' &&
            ['ECANCELED', 'ERR_STREAM_DESTROYED'].includes(publicTerminals.get(2)?.code)))
      )
    }
    const fsClosed = (endpoint) => proved(endpoint, true)
    const socketClosed = (endpoint) => proved(endpoint, false)
    const bulkAccepted = () => {
      const terminal = publicTerminals.get(2)
      if (!terminal) return false
      const destroy = first('local-destroy', 'writer4', 'requested')
      const callback = eventHistory.findIndex(
        (item) => item.op === 'api-write' && item.id === 2 && ['fulfilled', 'rejected'].includes(item.state)
      )
      if (destroy < 0 || callback <= destroy) return false
      if (terminal.state === 'fulfilled') return streamErrors.length === 0
      if (
        caseId !== 'N06' ||
        terminal.state !== 'rejected' ||
        !['ECANCELED', 'ERR_STREAM_DESTROYED'].includes(terminal.code)
      )
        return false
      return eventHistory.every(
        (item, index) =>
          item.op !== 'stream-error' ||
          (item.endpoint === 'writer4' && item.error?.code === terminal.code && index > destroy)
      )
    }
    if (caseId === 'N01') return destroyed && streamErrors.length === 0 && fsClosed('reader3') && fsClosed('writer4')
    if (caseId === 'N02')
      return destroyed && streamErrors.length === 0 && socketClosed('reader3') && socketClosed('writer4')
    if (caseId === 'N03')
      return peerClosedAccepted && streamErrors.length === 0 && fsClosed('writer4') && !closed.has('reader3')
    if (caseId === 'N04')
      return (
        peerClosedAccepted &&
        streamErrors.length === 0 &&
        eventHistory.some(
          (item) =>
            item.op === 'stream-end' &&
            item.endpoint === 'writer4' &&
            item.seq < (eventHistory.find((row) => row.op === 'stream-close' && row.endpoint === 'writer4')?.seq ?? -1)
        ) &&
        socketClosed('writer4') &&
        !closed.has('reader3')
      )
    if (caseId === 'N05') return destroyed && bulkAccepted() && fsClosed('reader3') && fsClosed('writer4')
    if (caseId === 'N06') return destroyed && bulkAccepted() && socketClosed('reader3') && socketClosed('writer4')
    return false
  }

  function scheduleSample() {
    if (sampleSent || !goalSeen) return
    if (goalPredicate()) return takeSample()
    if (sampleTimerArmed) return
    sampleTimerArmed = true
    sampleDeadline ??= performance.now() + 1000
    setTimeout(
      () => {
        if (!sampleSent) takeSample()
      },
      Math.max(0, sampleDeadline - performance.now())
    )
  }

  function takeSample() {
    if (sampleSent) return
    sampleSent = true
    phase = 'goal'
    barrier('sample')
    wake()
  }

  function maybeFinish() {
    if (!finalAsked || finalSent || sendQueue.length || pendingSend) return
    if (closed.size < acquired.size || nativePending.size || publicPending.size) return
    if (seq >= 128 || queueFailed) {
      childFailure('final child record bound')
      return
    }
    finalSent = true
    phase = 'finish'
    const payload = { v: 1, kind: 'final', caseId, seq: ++seq, phase, lastEventSeq: seq - 1 }
    const wire = JSON.stringify(payload)
    issuedSends++
    finalSendState = 'pending'
    try {
      process.send(wire, (error) => {
        completedSends++
        finalSendCallback = true
        finalSendState = error ? 'callback-rejected' : 'callback-fulfilled'
        finalSendError = error ? errorProjection(error) : null
        if (error) {
          failed = true
          process.exitCode = 1
        }
        if (process.connected) process.disconnect()
      })
    } catch (error) {
      finalSendState = 'threw'
      finalSendError = errorProjection(error)
      childFailure(error)
    }
  }

  async function finishAfterRescue() {
    finalAsked = true
    maybeFinish()
    while (!finalSent && !failed) {
      await new Promise((resolve) => {
        settleWake = resolve
      })
      maybeFinish()
    }
  }

  function validateCommand(command) {
    assert(!commandSeen.has(command) && !finalAsked && !finalSent, 'duplicate or late command')
    const seen = (name) => commandSeen.has(name)
    if (command === 'begin') assert(commandSeen.size === 0 && phase === 'setup' && !gotInput, 'begin transition')
    if (command === 'arm')
      assert(
        seen('begin') &&
          !seen('goal') &&
          phase === 'setup' &&
          !armAsked &&
          gotInput &&
          writeOneDone &&
          gotReverse &&
          acquired.size === 2,
        'arm transition'
      )
    if (command === 'goal') assert(seen('arm') && armed && !goalSeen && !sampleSent, 'goal transition')
    if (command === 'peer-closed')
      assert(
        seen('goal') && (caseId === 'N03' || caseId === 'N04') && phase === 'goal' && goalSeen && !sampleSent,
        'peer-close transition'
      )
    if (command === 'rescue-destroy')
      assert((sampleSent || armFailed || goalRefused) && !seen('rescue-input-eof'), 'rescue destroy transition')
    if (command === 'rescue-drain')
      assert(
        BULK.has(caseId) && (sampleSent || armFailed || goalRefused) && !seen('rescue-input-eof'),
        'drain transition'
      )
    if (command === 'rescue-input-eof')
      assert(
        (sampleSent || armFailed || goalRefused) && (!BULK.has(caseId) || seen('rescue-drain')),
        'input EOF transition'
      )
    if (command === 'finish')
      assert(
        (sampleSent || armFailed || goalRefused) &&
          (!BULK.has(caseId) || seen('rescue-drain')) &&
          ((caseId !== 'N03' && caseId !== 'N04') || seen('rescue-destroy')),
        'finish transition'
      )
  }

  function onCommand(command) {
    assert(
      ['begin', 'arm', 'goal', 'peer-closed', 'rescue-destroy', 'rescue-drain', 'rescue-input-eof', 'finish'].includes(
        command
      ),
      'unknown command'
    )
    if (command === 'begin') {
      assert(!gotInput && phase === 'setup', 'duplicate begin')
      try {
        acquireEndpoints()
      } catch (error) {
        childFailure(error)
        phase = 'finish'
        childEntryCleanup()
        finalAsked = true
        maybeFinish()
        return
      }
      const reader = streams.reader3 || sockets.reader3
      if (streams.reader3) reader.resume()
      return
    }
    if (command === 'arm') {
      assert(!armAsked && phase === 'setup', 'duplicate arm')
      armAsked = true
      if (BULK.has(caseId)) {
        const output = streams.writer4 || sockets.writer4
        publicWrite(output, 2, bulkBuffer, () => {})
      }
      maybeArm()
      return
    }
    if (command === 'goal') {
      assert(armed && !goalSeen, 'goal without arm')
      phase = 'goal'
      if (!SOCKET.has(caseId) && !fsPendingRead()) {
        goalRefused = true
        event('goal', 'reader3', 0, 'rejected')
        return
      }
      if (BULK.has(caseId)) {
        const nativeWritePending = SOCKET.has(caseId) || nativeBulkPending()
        if (!publicPending.has(2) || bulkCallbackDone || !bulkReturnedFalse || !nativeWritePending) {
          goalRefused = true
          event('goal', 'writer4', 2, 'rejected')
          return
        }
      }
      goalSeen = true
      event('goal', 'none', 0, 'start')
      if (caseId !== 'N03' && caseId !== 'N04') sampleDeadline = performance.now() + 1000
      if (caseId !== 'N03' && caseId !== 'N04') destroyOwned()
      if (caseId === 'N03' || caseId === 'N04') return
      scheduleSample()
      return
    }
    if (command === 'peer-closed') {
      assert(goalSeen && (caseId === 'N03' || caseId === 'N04') && !sampleSent, 'unexpected peer-closed')
      peerClosedAccepted = true
      sampleDeadline = performance.now() + 1000
      scheduleSample()
      return
    }
    if (command === 'rescue-destroy') {
      assert(sampleSent || armFailed || goalRefused, 'unexpected rescue destroy')
      phase = 'rescue'
      destroyOwned()
      return
    }
    if (command === 'rescue-drain') {
      assert((sampleSent || armFailed || goalRefused) && BULK.has(caseId), 'unexpected drain')
      phase = 'rescue'
      return
    }
    if (command === 'rescue-input-eof') {
      assert(sampleSent || armFailed || goalRefused, 'input EOF before sample')
      phase = 'rescue'
      return
    }
    if (command === 'finish') {
      assert(sampleSent || armFailed || goalRefused, 'finish before sample')
      phase = 'finish'
      finalAsked = true
      finishAfterRescue().catch((error) => {
        childFailure(error)
      })
    }
  }

  const binding = {
    v: 1,
    kind: 'binding',
    caseId,
    seq: ++seq,
    sourceHead: env.METIS_N0_HEAD,
    entryGitSha256: env.METIS_N0_ENTRY_GIT_SHA256,
    entryCheckoutSha256: ownHash,
    sourceSetSha256,
    execPathSha256: digestText(process.execPath),
    nodeVersion: versions.nodeVersion,
    platform: versions.platform,
    arch: versions.arch,
    versions: versions.versions
  }
  emitPayload(binding)
}
