import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { runChild } from './persistence-fixed-stdio-native-child.mjs'
import { runReplay, admitUpload } from './persistence-fixed-stdio-native-replay.mjs'
import {
  BASE,
  SCHEMA,
  ENTRY,
  IDS,
  NAMES,
  SOCKET,
  BULK,
  OP,
  PHASE,
  STATES,
  OUTCOMES,
  MAX_TOTAL,
  MAX_META,
  MAX_CASE,
  MAX_STDERR,
  MAX_PEER_OUT,
  MAX_PAYLOAD,
  MAX_ENVELOPE,
  assert,
  hash,
  digestText,
  exactKeys,
  errorProjection,
  stickyFailure,
  provenance,
  sourceFence,
  hashExecutable,
  runnerDirectory,
  namesFor,
  artifactLimit,
  createArtifacts,
  closeArtifactRegistry,
  acquiredCustody,
  closedCustody,
  custodyText,
  guardFile,
  boundedJson,
  recordCollectorExit,
  emitWorkflowOutputs,
  readHeldPrefix,
  readFooter,
  replayEventShape,
  readClosedArtifact,
  parseNdjson,
  writeAll,
  caseRaw,
  caseParentRecord,
  globalParentRecord,
  collectorCaseRow
} from './persistence-fixed-stdio-native-evidence.mjs'

function validateChildRecord(state, wire) {
  assert(
    typeof wire === 'string' && wire.length <= MAX_PAYLOAD && Buffer.byteLength(wire) <= MAX_PAYLOAD,
    'child IPC must be a bounded string'
  )
  const item = JSON.parse(wire)
  assert(JSON.stringify(item) === wire, 'canonical child record required')
  assert(item && item.v === 1 && item.caseId === state.id, 'child record binding')
  assert(Number.isSafeInteger(item.seq) && item.seq === state.childSeq + 1, 'child sequence')
  assert(!state.barriers.has('final'), 'application record after final')
  let commit = () => {}
  if (item.kind === 'binding') {
    exactKeys(
      item,
      [
        'v',
        'kind',
        'caseId',
        'seq',
        'sourceHead',
        'entryGitSha256',
        'entryCheckoutSha256',
        'sourceSetSha256',
        'execPathSha256',
        'nodeVersion',
        'platform',
        'arch',
        'versions'
      ],
      'binding'
    )
    assert(item.seq === 1 && /^[0-9a-f]{40}$/.test(item.sourceHead), 'child head')
    assert(
      /^[0-9a-f]{64}$/.test(item.entryGitSha256) &&
        /^[0-9a-f]{64}$/.test(item.entryCheckoutSha256) &&
        /^[0-9a-f]{64}$/.test(item.execPathSha256) &&
        /^[0-9a-f]{64}$/.test(item.sourceSetSha256),
      'child hashes'
    )
    exactKeys(item.versions, ['v8', 'modules', 'uv'], 'child versions')
    for (const value of Object.values(item.versions))
      assert(typeof value === 'string' && value.length <= 64 && Buffer.byteLength(value) <= 64, 'child version bound')
    assert(
      item.nodeVersion === state.meta.runtime.nodeVersion &&
        item.platform === state.meta.runtime.platform &&
        item.arch === state.meta.runtime.arch,
      'child runtime binding'
    )
    commit = () => {
      state.binding = item
    }
  } else if (item.kind === 'event') {
    replayEventShape(item, state.id, item.seq)
    if (item.op === 'acquire' && item.endpoint === 'writer4')
      assert(state.acquired.has('reader3'), 'writer acquisition after missing reader')
    if (['reader3', 'writer4'].includes(item.endpoint) && item.op !== 'acquire')
      assert(state.acquired.has(item.endpoint), 'event before acquired endpoint')
    if (item.op === 'api-write' && item.state === 'start')
      assert(!state.barriers.has('armed'), 'child public write after armed boundary')
    if (item.op === 'acquire') assert(!state.barriers.has('armed'), 'child acquisition after armed boundary')
    if (item.state === 'start' || item.op === 'local-destroy')
      assert(!state.closeEnds.has(item.endpoint), 'new child operation after endpoint close')
    if (item.op.startsWith('fs-')) {
      if (item.state === 'start') {
        assert(item.id > 0 && !state.nativeStarts.has(item.id), 'duplicate native start')
      } else if (['fulfilled', 'rejected', 'threw'].includes(item.state)) {
        const start = state.nativeStarts.get(item.id)
        assert(start && start.op === item.op && start.endpoint === item.endpoint, 'native completion mismatch')
        assert(!state.nativeCompletions.has(item.id), 'duplicate native completion')
      }
    }
    commit = () => {
      state.childEvents.push(item)
      if (item.op.startsWith('fs-')) {
        if (item.state === 'start')
          state.nativeStarts.set(item.id, { id: item.id, op: item.op, endpoint: item.endpoint })
        else if (['fulfilled', 'rejected', 'threw'].includes(item.state))
          state.nativeCompletions.set(item.id, item.state)
      }
      if (item.op === 'acquire' && item.state === 'fulfilled') state.acquired.add(item.endpoint)
      if (item.op === 'acquire' && item.state === 'rejected') state.outcome = 'API_ACQUISITION_REJECTED'
      if (item.op === 'goal' && item.state === 'rejected') state.outcome = 'PREREQUISITE_UNREACHED'
      if (item.op === 'stream-close') state.closeEnds.add(item.endpoint)
      if (item.op === 'fd-check' && item.state === 'rejected' && item.error?.code === 'EBADF')
        state.fdProof.add(item.endpoint)
    }
  } else if (item.kind === 'command-ack') {
    exactKeys(
      item,
      ['v', 'kind', 'caseId', 'seq', 'commandSeq', 'command', 'phase', 'lastEventSeq'],
      'command acknowledgement'
    )
    assert(
      item.commandSeq === state.acks.size + 1 &&
        item.commandSeq <= state.commandSeq &&
        item.command === state.commands.get(item.commandSeq) &&
        item.lastEventSeq === item.seq - 1,
      'command acknowledgement pairing'
    )
    commit = () => {
      state.acks.set(item.commandSeq, item)
    }
  } else if (['armed', 'sample', 'final'].includes(item.kind)) {
    exactKeys(item, ['v', 'kind', 'caseId', 'seq', 'phase', 'lastEventSeq'], 'child barrier')
    assert(PHASE.has(item.phase) && item.lastEventSeq === item.seq - 1, 'barrier frontier')
    assert(!state.barriers.has(item.kind), 'duplicate child barrier')
    commit = () => {
      state.barriers.set(item.kind, item)
    }
  } else {
    throw new Error('unknown child record kind')
  }
  assert(state.binding || item.kind === 'binding', 'binding must be first')
  assert(caseRaw(state, 'child', wire), 'child raw admission failed')
  commit()
  state.childSeq = item.seq
  if (item.kind === 'sample')
    state.sample = {
      seq: item.seq,
      ordinal: state.ordinal,
      bytes: state.artifacts.sizes.get(state.id + '.events.ndjson')
    }
  state.childRecords.push(item)
  state.notify()
}

function makeCaseState(id, artifacts, meta) {
  const state = {
    id,
    name: NAMES[IDS.indexOf(id)],
    meta,
    artifacts,
    ordinal: 0,
    childSeq: 0,
    parentSeq: 0,
    commandSeq: 0,
    commands: new Map(),
    acks: new Map(),
    sample: null,
    frontierStatus: 'unset',
    frontierFailure: undefined,
    sticky: null,
    hasSticky: false,
    childRecords: [],
    timeline: [],
    childEvents: [],
    parentRecords: [],
    barriers: new Map(),
    nativeStarts: new Map(),
    nativeCompletions: new Map(),
    binding: null,
    processExit: null,
    processClose: false,
    peer3Closed: false,
    peer4Closed: false,
    stderrClosed: false,
    stderrEnded: false,
    peer3Ended: false,
    peer4Ended: false,
    ipcDisconnected: false,
    spawned: false,
    spawnStarted: false,
    spawnError: null,
    peerWrites: 0,
    peerWriteCallbacks: 0,
    peerReadBytes: 0,
    peerOutputBytes: 0,
    stderrBytes: 0,
    stderrOverflow: false,
    stderrText: '',
    footer: null,
    acquired: new Set(),
    closeEnds: new Set(),
    fdProof: new Set(),
    errors: [],
    hasPrimaryFailure: false,
    primaryFailure: undefined,
    secondaryFailures: [],
    recordedErrors: [],
    waiters: new Set(),
    parentPublicPending: new Set(),
    parentWriteTerminals: new Map(),
    parentWriteReturns: new Map(),
    parentSendReturns: new Map(),
    parentEndReturn: null,
    peerOutputHead: Buffer.alloc(0),
    peerEndsIssued: 0,
    peerEndsCompleted: 0,
    peerEndsThrew: 0,
    parentWriteThrew: 0,
    parentSendsThrew: 0,
    child: null,
    peer3: null,
    peer4: null,
    stderr: null,
    outcome: 'INCOMPLETE_INFRA',
    diagnostic: 'PARTIAL',
    attempted: false,
    timeout: false,
    terminated: false,
    signals: [],
    safeOwnership: false,
    finalizing: false,
    ownerPromise: null,
    finalizationPromise: null,
    terminalCutoff: null,
    notify() {
      for (const fn of [...this.waiters]) fn()
    }
  }
  return state
}

function callbacksJoined(state) {
  return (
    state.peerWrites === state.peerWriteCallbacks + state.parentWriteThrew &&
    state.peerEndsIssued === state.peerEndsCompleted + state.peerEndsThrew &&
    state.parentSendsIssued === state.parentSendsCompleted + state.parentSendsThrew &&
    state.parentPublicPending.size === 0
  )
}

function physicalJoin(state) {
  return (
    Boolean(state.processExit || (state.spawnError && !state.spawned)) &&
    [state.processClose, state.peer3Closed, state.peer4Closed, state.stderrClosed, state.ipcDisconnected].every(
      Boolean
    ) &&
    callbacksJoined(state)
  )
}

function waitFor(state, predicate, deadline, label, ignoreSticky = false) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      state.waiters.delete(check)
    }
    const check = () => {
      try {
        if (state.hasSticky && !ignoreSticky) throw state.sticky
        if (performance.now() >= deadline) {
          cleanup()
          reject(new Error('case budget expired: ' + label))
        } else if (predicate()) {
          cleanup()
          resolve()
        }
      } catch (error) {
        cleanup()
        reject(error)
      }
    }
    const delay = Math.max(0, deadline - performance.now())
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('case budget expired: ' + label))
    }, delay)
    state.waiters.add(check)
    check()
  })
}

function parseFooter(state) {
  state.footer = readFooter(Buffer.from(state.stderrText), state.id)
}

function logReasons(prefix, error) {
  const failures = []
  for (const reason of error instanceof AggregateError ? error.errors : [error]) {
    try {
      fs.writeSync(2, prefix + String(reason?.stack || reason).slice(0, 1024) + '\n')
    } catch (failure) {
      failures.push(failure)
    }
  }
  return failures
}

function retainExitFailure(artifacts, prefix, error) {
  artifacts.failures.push(error)
  process.exitCode = 2
  try {
    for (const failure of logReasons(prefix, error)) artifacts.failures.push(failure)
  } catch (failure) {
    artifacts.failures.push(failure)
  }
}

async function sendCommand(state, command, deadline) {
  assert(state.commandSeq < 12, 'command cap')
  const payload = {
    v: 1,
    kind: 'command',
    caseId: state.id,
    seq: ++state.commandSeq,
    command
  }
  assert(
    ['begin', 'arm', 'goal', 'peer-closed', 'rescue-destroy', 'rescue-drain', 'rescue-input-eof', 'finish'].includes(
      command
    ),
    'parent command enum'
  )
  caseRaw(state, 'parent', JSON.stringify(payload))
  assert(!state.hasSticky, 'command raw admission failed')
  const id = state.commandSeq
  state.commands.set(id, command)
  caseParentRecord(state, state.phase || 'setup', 'ipc-send', 'ipc', id, 'start')
  let done = false
  let failure = null
  state.parentSendsIssued++
  try {
    const returned = state.child.send(JSON.stringify(payload), (error) => {
      state.parentSendsCompleted++
      done = true
      failure = error || null
      try {
        caseParentRecord(state, state.phase || 'setup', 'ipc-send', 'ipc', id, error ? 'rejected' : 'fulfilled', {
          error: error ? errorProjection(error) : null
        })
      } catch (observationError) {
        stickyFailure(state, observationError)
      }
      state.notify()
    })
    state.parentSendReturns.set(id, returned)
  } catch (error) {
    try {
      caseParentRecord(state, state.phase || 'setup', 'ipc-send', 'ipc', id, 'threw', { error: errorProjection(error) })
    } catch (observationError) {
      stickyFailure(state, observationError)
    }
    state.parentSendsThrew++
    throw error
  }
  assert(typeof state.parentSendReturns.get(id) === 'boolean', 'actual IPC send return')
  await waitFor(state, () => done, deadline, 'IPC send callback')
  if (failure) throw failure
  await waitFor(state, () => state.acks.has(id), deadline, 'command acknowledgement')
}

function durableFrontier(state) {
  if (state.frontierStatus === 'committed') return state.frontier
  if (state.frontierStatus === 'failed') throw state.frontierFailure
  assert(state.frontierStatus === 'unset', 'frontier cut reentry')
  state.frontierStatus = 'in-progress'
  try {
    state.phase = 'rescue'
    const name = state.id + '.events.ndjson'
    const handle = state.artifacts.handles.get(name)
    assert(handle && !handle.closeAttempted, 'case raw owner absent')
    const size = state.sample?.bytes ?? state.artifacts.sizes.get(name)
    guardFile(
      state.artifacts.directory,
      state.artifacts.root,
      { name, dev: String(handle.stat.dev), ino: String(handle.stat.ino) },
      name
    )
    fs.fsyncSync(handle.fd)
    const bytes = readHeldPrefix(handle.fd, size, MAX_CASE, handle.stat)
    const digest = hash(bytes)
    assert(
      caseParentRecord(state, state.phase, 'frontier-fsync', 'ipc', 0, 'fulfilled', {
        bytes: size,
        dataSha256: digest
      }),
      'frontier record not admitted'
    )
    fs.fsyncSync(handle.fd)
    const heldAfterCut = fs.fstatSync(handle.fd, { bigint: true })
    assert(
      heldAfterCut.isFile() &&
        !heldAfterCut.isSymbolicLink() &&
        heldAfterCut.nlink === 1n &&
        heldAfterCut.dev === handle.stat.dev &&
        heldAfterCut.ino === handle.stat.ino &&
        heldAfterCut.size === BigInt(state.artifacts.sizes.get(name)),
      'durable cut held owner/version size'
    )
    guardFile(
      state.artifacts.directory,
      state.artifacts.root,
      { name, dev: String(handle.stat.dev), ino: String(handle.stat.ino) },
      name
    )
    state.frontier = { bytes: size, sha256: digest, ordinal: state.ordinal, childSeq: state.childSeq || null }
    state.frontierStatus = 'committed'
    return state.frontier
  } catch (error) {
    state.frontierFailure = error
    state.frontierStatus = 'failed'
    stickyFailure(state, error)
    state.artifacts.failures.push(error)
    throw error
  }
}

async function drainBulk(state, deadline) {
  await sendCommand(state, 'rescue-drain', deadline)
  assert(deadline - performance.now() >= 2000, 'full drain epoch unavailable before admission')
  assert(caseParentRecord(state, 'rescue', 'peer-resume', 'writer4', 0, 'requested'), 'resume edge admission')
  const resumeAt = performance.now()
  assert(deadline - resumeAt >= 2000, 'full drain epoch unavailable after admission')
  state.peer4.resume()
  const drainDeadline = resumeAt + 2000
  try {
    await waitFor(
      state,
      () =>
        state.childEvents.some(
          (item) => item.op === 'api-write' && item.id === 2 && ['fulfilled', 'rejected'].includes(item.state)
        ) && state.childEvents.some((item) => item.op === 'stream-close' && item.endpoint === 'writer4'),
      drainDeadline,
      'bulk callback/writer close'
    )
  } catch (error) {
    if (performance.now() < drainDeadline || state.hasSticky) throw error
    caseParentRecord(state, 'rescue', 'drain-expiry', 'writer4', 0, 'observed')
  }
}

async function rescueInput(state, deadline) {
  if (state.peer3Closed) return
  await sendCommand(state, 'rescue-input-eof', deadline)
  if (!state.peer3Closed && !state.peer3.writableEnded) endInput(state)
}

function endInput(state) {
  assert(caseParentRecord(state, state.phase || 'rescue', 'peer-end', 'reader3', 0, 'requested'), 'EOF edge admission')
  state.peerEndsIssued++
  try {
    const returned = state.peer3.end(
      observe(state, (error) => {
        state.peerEndsCompleted++
        if (error) {
          stickyFailure(state, error)
          state.errors.push(errorProjection(error))
        }
        caseParentRecord(state, state.phase || 'rescue', 'peer-end', 'reader3', 0, error ? 'rejected' : 'fulfilled', {
          error: error ? errorProjection(error) : null
        })
        state.notify()
      })
    )
    state.parentEndReturn = returned
  } catch (error) {
    state.peerEndsThrew++
    stickyFailure(state, error)
    try {
      caseParentRecord(state, state.phase || 'rescue', 'peer-end', 'reader3', 0, 'threw', {
        error: errorProjection(error)
      })
    } catch (observationError) {
      stickyFailure(state, observationError)
    }
    throw error
  }
}

function writeParent(state, endpoint, id, bytes) {
  const stream = endpoint === 'reader3' ? state.peer3 : state.peer4
  state.peerWrites++
  state.parentPublicPending.add(id)
  try {
    caseParentRecord(state, 'setup', 'api-write', endpoint, id, 'start', {
      bytes: bytes.length,
      dataSha256: hash(bytes)
    })
  } catch (observationError) {
    stickyFailure(state, observationError)
  }
  let returned
  try {
    returned = stream.write(bytes, (error) => {
      state.peerWriteCallbacks++
      state.parentPublicPending.delete(id)
      state.parentWriteTerminals.set(id, error ? 'rejected' : 'fulfilled')
      try {
        caseParentRecord(state, 'setup', 'api-write', endpoint, id, error ? 'rejected' : 'fulfilled', {
          bytes: bytes.length,
          dataSha256: hash(bytes),
          error: error ? errorProjection(error) : null
        })
      } catch (observationError) {
        stickyFailure(state, observationError)
      }
      state.notify()
    })
    state.parentWriteReturns.set(id, returned)
  } catch (error) {
    state.parentPublicPending.delete(id)
    state.parentWriteTerminals.set(id, 'threw')
    state.parentWriteThrew++
    try {
      caseParentRecord(state, 'setup', 'api-write', endpoint, id, 'threw', { error: errorProjection(error) })
    } catch (observationError) {
      stickyFailure(state, observationError)
    }
    throw error
  }
  try {
    caseParentRecord(state, 'setup', 'api-write', endpoint, id, 'observed', { result: returned })
    if (endpoint === 'reader3') state.artifacts.append(state.id + '.peer-input.bin', bytes)
  } catch (observationError) {
    stickyFailure(state, observationError)
  }
  return returned
}

function observe(state, callback) {
  return (...args) => {
    try {
      callback(...args)
    } catch (error) {
      stickyFailure(state, error)
      for (const failure of logReasons('METIS_N0_OBSERVER_FAILURE ', error)) stickyFailure(state, failure)
      state.notify()
    }
  }
}

function attachCaseProcess(state) {
  const child = state.child
  child.on(
    'spawn',
    observe(state, () => {
      state.spawned = true
      caseParentRecord(state, 'setup', 'spawn', 'process', 0, 'fulfilled')
      state.notify()
    })
  )
  child.on(
    'message',
    observe(state, (wire) => validateChildRecord(state, wire))
  )
  child.on(
    'error',
    observe(state, (error) => {
      state.spawnError = !state.spawned ? errorProjection(error) : null
      state.errors.push(errorProjection(error))
      caseParentRecord(
        state,
        state.spawned ? 'rescue' : 'setup',
        state.spawned ? 'fatal' : 'spawn',
        'process',
        0,
        state.spawned ? 'observed' : 'rejected',
        { error: errorProjection(error) }
      )
      state.notify()
    })
  )
  for (const kind of ['exit', 'close'])
    child.on(
      kind,
      observe(state, (code, signal) => {
        if (kind === 'exit') state.processExit = { code, signal }
        else state.processClose = true
        caseRaw(
          state,
          'parent',
          JSON.stringify({
            v: 1,
            kind: 'process-terminal',
            caseId: state.id,
            seq: ++state.parentSeq,
            event: kind,
            code: Number.isSafeInteger(code) ? code : null,
            signal: typeof signal === 'string' ? signal.slice(0, 16) : null
          })
        )
        if (kind === 'close') parseFooter(state)
        state.notify()
      })
    )
  child.on(
    'disconnect',
    observe(state, () => {
      state.ipcDisconnected = true
      caseParentRecord(state, state.phase || 'finish', 'ipc-disconnect', 'ipc', 0, 'observed')
      state.notify()
    })
  )
  state.peer3 = child.stdio[3]
  state.peer4 = child.stdio[4]
  state.stderr = child.stderr
  for (const [stream, endpoint] of [
    [state.peer3, 'reader3'],
    [state.peer4, 'writer4']
  ]) {
    assert(stream && typeof stream.write === 'function', 'inherited pipe stream missing')
    stream.on(
      'error',
      observe(state, (error) => {
        const projection = errorProjection(error)
        state.errors.push(projection)
        caseParentRecord(state, state.phase, 'stream-error', endpoint, 0, 'rejected', { error: projection })
        state.notify()
      })
    )
    stream.prependListener(
      'close',
      observe(state, () => {
        if (endpoint === 'reader3') state.peer3Closed = true
        else state.peer4Closed = true
        caseParentRecord(state, state.phase, 'peer-close', endpoint, 0, 'observed')
        state.notify()
      })
    )
  }
  state.peer3.on(
    'end',
    observe(state, () => {
      state.peer3Ended = true
      caseParentRecord(state, state.phase, 'stream-end', 'reader3', 0, 'observed')
    })
  )
  state.peer3.on(
    'finish',
    observe(state, () => caseParentRecord(state, state.phase, 'peer-end', 'reader3', 0, 'observed'))
  )
  state.peer4.on(
    'end',
    observe(state, () => {
      state.peer4Ended = true
      caseParentRecord(state, state.phase, 'stream-end', 'writer4', 0, 'observed')
    })
  )
  state.peer4.on(
    'data',
    observe(state, (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      assert(state.peerOutputBytes + bytes.length <= artifactLimit(state.id + '.peer-output.bin'), 'peer output bound')
      state.artifacts.append(state.id + '.peer-output.bin', bytes)
      if (state.peerOutputHead.length === 0) state.peerOutputHead = Buffer.from(bytes.subarray(0, 1))
      state.peerOutputBytes += bytes.length
      caseParentRecord(state, state.phase, 'peer-read', 'writer4', 0, 'observed', {
        bytes: bytes.length,
        dataSha256: hash(bytes)
      })
      state.notify()
    })
  )
  assert(state.stderr, 'child stderr missing')
  state.stderr.on(
    'data',
    observe(state, (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      let hasCaptureFailure = false
      let captureFailure
      let hasForwardFailure = false
      let forwardFailure
      try {
        const room = MAX_STDERR - state.stderrBytes
        const admitted = bytes.subarray(0, Math.max(0, room))
        if (admitted.length) {
          state.artifacts.append(state.id + '.stderr.raw.log', admitted)
          state.stderrBytes += admitted.length
          state.stderrText += admitted.toString('utf8')
        }
        if (admitted.length !== bytes.length) {
          state.stderrOverflow = true
          throw new Error('child stderr overflow')
        }
      } catch (error) {
        hasCaptureFailure = true
        captureFailure = error
      }
      try {
        writeAll(2, bytes)
      } catch (error) {
        hasForwardFailure = true
        forwardFailure = error
      }
      state.notify()
      if (hasCaptureFailure && hasForwardFailure)
        throw new AggregateError([captureFailure, forwardFailure], 'stderr capture and default forwarding failed')
      if (hasCaptureFailure) throw captureFailure
      if (hasForwardFailure) throw forwardFailure
    })
  )
  state.stderr.on(
    'error',
    observe(state, (error) => {
      const projection = errorProjection(error)
      state.errors.push(projection)
      caseParentRecord(state, state.phase, 'stream-error', 'process', 0, 'rejected', { error: projection })
      state.notify()
    })
  )
  state.stderr.on(
    'end',
    observe(state, () => {
      state.stderrEnded = true
      caseParentRecord(state, state.phase, 'stream-end', 'process', 0, 'observed')
    })
  )
  state.stderr.prependListener(
    'close',
    observe(state, () => {
      state.stderrClosed = true
      parseFooter(state)
      caseParentRecord(state, state.phase, 'stream-close', 'process', 0, 'observed')
      state.notify()
    })
  )
}

function deriveOutcome(state) {
  const sampled = state.barriers.get('sample')
  const prefix = state.sample ? state.timeline.filter((entry) => entry.ordinal <= state.sample.ordinal) : []
  const events = prefix
    .filter((entry) => entry.origin === 'child' && entry.item.kind === 'event')
    .map((entry) => entry.item)
  const parents = prefix
    .filter((entry) => entry.origin === 'parent' && entry.item.kind === 'parent')
    .map((entry) => entry.item)
  const find = (op, endpoint, test = () => true) =>
    events.find((item) => item.op === op && item.endpoint === endpoint && test(item))
  const parent = (op, endpoint, test = () => true) =>
    parents.some((item) => item.op === op && item.endpoint === endpoint && test(item))
  const acquiredFailure = state.childEvents.some((item) => item.op === 'acquire' && item.state === 'rejected')
  if (acquiredFailure) return 'API_ACQUISITION_REJECTED'
  const refused = state.childEvents.some((item) => item.op === 'goal' && item.state === 'rejected')
  if (!sampled) return refused ? 'PREREQUISITE_UNREACHED' : 'INCOMPLETE_INFRA'
  const arm = state.barriers.get('armed')
  const goal = find('goal', 'none', (item) => item.state === 'start')
  const beforeArm = (item) => arm && item.seq < arm.seq
  const parentBeforeArm = (item) => arm && (item.childSeq === null || item.childSeq < arm.seq)
  const destroy = find('local-destroy', 'writer4', (item) => item.state === 'requested')
  const readerDestroy = find('local-destroy', 'reader3', (item) => item.state === 'requested')
  const bothDestroy = readerDestroy && destroy && readerDestroy.seq < destroy.seq
  const healthy =
    ['reader3', 'writer4'].every((endpoint) =>
      find('acquire', endpoint, (item) => item.state === 'fulfilled' && beforeArm(item))
    ) &&
    find('acquire', 'reader3', (item) => item.state === 'fulfilled')?.seq <
      find('acquire', 'writer4', (item) => item.state === 'fulfilled')?.seq &&
    find(
      SOCKET.has(state.id) ? 'socket-read' : 'peer-read',
      'reader3',
      (item) => beforeArm(item) && item.bytes === 1 && item.dataSha256 === hash(Buffer.from([0x61]))
    ) &&
    find(
      'api-write',
      'writer4',
      (item) =>
        beforeArm(item) && item.id === 1 && item.state === 'fulfilled' && item.dataSha256 === hash(Buffer.from([0x62]))
    ) &&
    ['start', 'observed'].every((eventState) =>
      find('api-write', 'writer4', (item) => beforeArm(item) && item.id === 1 && item.state === eventState)
    ) &&
    parent(
      'api-write',
      'reader3',
      (item) =>
        parentBeforeArm(item) &&
        item.id === 1 &&
        item.state === 'fulfilled' &&
        item.bytes === 1 &&
        item.dataSha256 === hash(Buffer.from([0x61]))
    ) &&
    ['start', 'observed'].every((eventState) =>
      parent('api-write', 'reader3', (item) => parentBeforeArm(item) && item.id === 1 && item.state === eventState)
    ) &&
    parent(
      'peer-read',
      'writer4',
      (item) => parentBeforeArm(item) && item.bytes >= 1 && state.peerOutputHead[0] === 0x62
    ) &&
    (!SOCKET.has(state.id) ||
      (find(
        'socket-read',
        'writer4',
        (item) => beforeArm(item) && item.bytes === 1 && item.dataSha256 === hash(Buffer.from([0x63]))
      ) &&
        parent(
          'api-write',
          'writer4',
          (item) =>
            parentBeforeArm(item) &&
            item.id === 2 &&
            item.state === 'fulfilled' &&
            item.bytes === 1 &&
            item.dataSha256 === hash(Buffer.from([0x63]))
        ) &&
        ['start', 'observed'].every((eventState) =>
          parent('api-write', 'writer4', (item) => parentBeforeArm(item) && item.id === 2 && item.state === eventState)
        )))
  const pending = (start, boundary) =>
    start.seq < boundary &&
    !events.some(
      (item) =>
        item.op === start.op &&
        item.id === start.id &&
        ['fulfilled', 'rejected', 'threw'].includes(item.state) &&
        item.seq < boundary
    )
  const firstRead = find(
    'fs-read',
    'reader3',
    (item) => item.state === 'fulfilled' && item.bytes === 1 && item.dataSha256 === hash(Buffer.from([0x61]))
  )
  const secondRead =
    SOCKET.has(state.id) ||
    Boolean(
      firstRead &&
        arm &&
        goal &&
        events.some(
          (start) =>
            start.op === 'fs-read' &&
            start.endpoint === 'reader3' &&
            start.state === 'start' &&
            start.seq > firstRead.seq &&
            [arm.seq, goal.seq, ...(destroy ? [destroy.seq] : [])].every((boundary) => pending(start, boundary))
        )
    )
  const bulkReturn = find(
    'api-write',
    'writer4',
    (item) => item.id === 2 && item.state === 'observed' && item.result === false
  )
  const bulkStart = find('api-write', 'writer4', (item) => item.id === 2 && item.state === 'start')
  const bulkCallback = find(
    'api-write',
    'writer4',
    (item) => item.id === 2 && ['fulfilled', 'rejected'].includes(item.state)
  )
  const nativeWrite =
    state.id !== 'N05' ||
    Boolean(
      arm &&
        goal &&
        destroy &&
        [arm.seq, goal.seq, destroy.seq].every((boundary) =>
          events.some(
            (start) =>
              ['fs-write', 'fs-writev'].includes(start.op) &&
              start.endpoint === 'writer4' &&
              start.state === 'start' &&
              bulkStart &&
              start.seq > bulkStart.seq &&
              start.seq < (bulkCallback?.seq ?? Infinity) &&
              pending(start, boundary)
          )
        )
    )
  const peerAction = state.parentRecords.find((item) => item.op === 'peer-destroy' && item.endpoint === 'writer4')
  const at = (predicate) => prefix.find((entry) => predicate(entry.item, entry.origin))?.ordinal ?? null
  const peerActionAt = at(
    (item, origin) =>
      origin === 'parent' &&
      item.kind === 'parent' &&
      item.seq === peerAction?.seq &&
      item.op === 'peer-destroy' &&
      item.endpoint === 'writer4' &&
      item.phase === 'goal'
  )
  const peerCloseAt = at(
    (item, origin) => origin === 'parent' && item.op === 'peer-close' && item.endpoint === 'writer4'
  )
  const peerCommandAt = at(
    (item, origin) => origin === 'parent' && item.kind === 'command' && item.command === 'peer-closed'
  )
  const peerAckAt = at(
    (item, origin) => origin === 'child' && item.kind === 'command-ack' && item.command === 'peer-closed'
  )
  const goalAt = at((item, origin) => origin === 'child' && item === goal)
  const outputCut =
    (state.id !== 'N03' && state.id !== 'N04') ||
    Boolean(
      goalAt !== null &&
        peerActionAt !== null &&
        peerCloseAt !== null &&
        peerCommandAt !== null &&
        peerAckAt !== null &&
        goalAt < peerActionAt &&
        peerActionAt < peerCloseAt &&
        peerCloseAt < peerCommandAt &&
        peerCommandAt < peerAckAt &&
        !parent('peer-end', 'reader3', (item) => item.state === 'requested') &&
        !parent('peer-destroy', 'reader3') &&
        !parent('stream-end', 'reader3') &&
        !parent('peer-close', 'reader3') &&
        !find('stream-close', 'reader3') &&
        !find('stream-end', 'reader3') &&
        !events.some((item) => item.op === 'api-write' && item.state === 'start' && item.seq > goal?.seq)
    )
  if (
    !arm ||
    !goal ||
    !healthy ||
    !secondRead ||
    !nativeWrite ||
    !outputCut ||
    refused ||
    (BULK.has(state.id) &&
      (!bulkReturn ||
        !bulkStart ||
        !destroy ||
        bulkStart.seq >= bulkReturn.seq ||
        bulkReturn.seq >= arm.seq ||
        bulkReturn.seq >= goal.seq ||
        (bulkCallback && bulkCallback.seq <= destroy.seq)))
  )
    return 'PREREQUISITE_UNREACHED'
  const physical = (endpoint, fsNative) => {
    const peerCaused = state.id === 'N03' || state.id === 'N04'
    const cause = peerCaused ? goal.seq : find('local-destroy', endpoint, (item) => item.state === 'requested')?.seq
    const close = find('stream-close', endpoint, (item) => item.seq > cause)
    const fd = find(
      'fd-check',
      endpoint,
      (item) => item.state === 'rejected' && item.error?.code === 'EBADF' && item.seq > (close?.seq ?? Infinity)
    )
    const native = fsNative
      ? find(
          'fs-close',
          endpoint,
          (item) => item.state === 'fulfilled' && item.seq > cause && item.seq < (close?.seq ?? Infinity)
        )
      : true
    return Boolean(
      close &&
        fd &&
        native &&
        (!peerCaused ||
          (peerActionAt !== null &&
            at((item, origin) => origin === 'child' && item === close) > peerActionAt &&
            (!fsNative || at((item, origin) => origin === 'child' && item === native) > peerActionAt))) &&
        (fsNative ||
          close.result === false ||
          (state.id === 'N06' && endpoint === 'writer4' && close.result === true && bulkCallback?.state === 'rejected'))
    )
  }
  const narrow =
    state.id === 'N06' &&
    bulkCallback?.state === 'rejected' &&
    destroy &&
    bulkCallback.seq > destroy.seq &&
    ['ECANCELED', 'ERR_STREAM_DESTROYED'].includes(bulkCallback.error?.code) &&
    !parent('peer-destroy', 'writer4')
  const childError = events.some(
    (item) =>
      item.error &&
      item.op !== 'fd-check' &&
      !(
        narrow &&
        (item === bulkCallback ||
          (item.op === 'stream-error' &&
            item.endpoint === 'writer4' &&
            item.seq > destroy.seq &&
            item.error.code === bulkCallback.error.code))
      )
  )
  const parentError = parents.some((item) => item.error && item.op !== 'fd-check')
  const error = childError || parentError
  if (error) return 'OBSERVED_ERROR'
  const localUninterrupted =
    !parent('peer-end', 'reader3', (item) => item.state === 'requested') &&
    !parent('peer-destroy', 'reader3') &&
    !parent('peer-destroy', 'writer4') &&
    !parent('peer-resume', 'writer4') &&
    !parent('infra-term', 'process')
  const positive =
    state.id === 'N01'
      ? localUninterrupted &&
        !find('stream-end', 'reader3') &&
        bothDestroy &&
        physical('reader3', true) &&
        physical('writer4', true)
      : state.id === 'N02'
        ? localUninterrupted && bothDestroy && physical('reader3', false) && physical('writer4', false)
        : state.id === 'N03'
          ? !find('local-destroy', 'reader3') &&
            !destroy &&
            physical('writer4', true) &&
            !find('stream-close', 'reader3')
          : state.id === 'N04'
            ? !find('local-destroy', 'reader3') &&
              !destroy &&
              find('stream-end', 'writer4', (item) => item.seq < (find('stream-close', 'writer4')?.seq ?? -1)) &&
              physical('writer4', false) &&
              !find('stream-close', 'reader3')
            : state.id === 'N05'
              ? localUninterrupted &&
                bothDestroy &&
                bulkCallback?.state === 'fulfilled' &&
                physical('reader3', true) &&
                physical('writer4', true)
              : localUninterrupted &&
                bothDestroy &&
                (bulkCallback?.state === 'fulfilled' || narrow) &&
                physical('reader3', false) &&
                physical('writer4', false)
  return positive ? 'OBSERVED_GOAL' : 'PENDING_AT_SAMPLE'
}

function runOneCase(state, globalOrdinal, targetMeta, outerDeadline) {
  state.ownerPromise ??= Promise.resolve().then(() => runOneCaseBody(state, globalOrdinal, targetMeta, outerDeadline))
  return state.ownerPromise
}

function finalizeCase(state) {
  state.finalizationPromise ??= Promise.resolve().then(() => {
    for (const name of namesFor(state.id)) {
      try {
        state.artifacts.closeAndHash(name)
      } catch (error) {
        stickyFailure(state, error)
        try {
          state.errors.push(errorProjection(error))
        } catch (projectionError) {
          stickyFailure(state, projectionError)
        }
        state.diagnostic = 'PARTIAL'
        for (const failure of logReasons('METIS_N0_CASE_SEAL_FAILURE ', error)) stickyFailure(state, failure)
      }
    }
    return state
  })
  return state.finalizationPromise
}

async function runOneCaseBody(state, globalOrdinal, targetMeta, outerDeadline) {
  const { id, artifacts, meta } = state
  state.phase = 'setup'
  state.parentSendsIssued = 0
  state.parentSendsCompleted = 0
  state.attempted = true
  const started = performance.now()
  const deadline = Math.min(started + 20000, outerDeadline - 5000)
  state.terminalCutoff = deadline
  const childEnv = {
    METIS_N0_CASE: id,
    METIS_N0_NAME: state.name,
    METIS_N0_BASE: BASE,
    METIS_N0_HEAD: targetMeta.head,
    METIS_N0_ENTRY_GIT_SHA256: targetMeta.files.find((file) => file.path === ENTRY).gitSha256,
    METIS_N0_ENTRY_CHECKOUT_SHA256: targetMeta.files.find((file) => file.path === ENTRY).checkoutSha256,
    METIS_N0_SOURCE_FILES: JSON.stringify(targetMeta.files),
    METIS_N0_SOURCE_SET_SHA256: targetMeta.sourceSetSha256,
    METIS_N0_RUN_ID: meta.runId,
    METIS_N0_ATTEMPT: meta.attempt,
    METIS_N0_JOB: meta.job,
    METIS_N0_TARGET: meta.target
  }
  if (process.platform === 'win32') {
    if (process.env.SystemRoot) childEnv.SystemRoot = process.env.SystemRoot
    if (process.env.WINDIR) childEnv.WINDIR = process.env.WINDIR
  }
  try {
    globalParentRecord(artifacts, globalOrdinal, {
      v: 1,
      kind: 'parent',
      caseId: null,
      seq: ++globalOrdinal.seq,
      phase: 'setup',
      op: 'spawn',
      endpoint: 'process',
      id: IDS.indexOf(id) + 1,
      state: 'start',
      bytes: null,
      dataSha256: null,
      result: null,
      error: null,
      childSeq: null
    })
    assert(caseParentRecord(state, 'setup', 'spawn', 'process', 0, 'start'), 'spawn start evidence admission')
    state.spawnStarted = true
    state.child = spawn(process.execPath, ['--unhandled-rejections=strict', path.resolve(ENTRY), '--child', id], {
      cwd: process.cwd(),
      env: childEnv,
      shell: false,
      detached: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe', 'ipc']
    })
    assert(state.child, 'spawn returned no child owner')
    attachCaseProcess(state)
    await waitFor(state, () => state.spawned || state.spawnError, deadline, 'spawn')
    assert(!state.spawnError, 'child spawn failed')
    await waitFor(state, () => state.binding || state.spawnError, deadline, 'child binding')
    assert(
      state.binding &&
        state.binding.sourceHead === targetMeta.head &&
        state.binding.entryGitSha256 === targetMeta.files.find((file) => file.path === ENTRY).gitSha256 &&
        state.binding.entryCheckoutSha256 === targetMeta.files.find((file) => file.path === ENTRY).checkoutSha256 &&
        state.binding.execPathSha256 === digestText(process.execPath) &&
        state.binding.sourceSetSha256 === targetMeta.sourceSetSha256,
      'child binding mismatch'
    )
    await sendCommand(state, 'begin', deadline)
    const first = Buffer.from([0x61])
    writeParent(state, 'reader3', 1, first)
    const acquisitionRejected = () =>
      state.childEvents.some((item) => item.op === 'acquire' && item.state === 'rejected')
    const healthy = () =>
      state.childEvents.some(
        (item) =>
          item.op === (SOCKET.has(id) ? 'socket-read' : 'peer-read') &&
          item.endpoint === 'reader3' &&
          item.dataSha256 === hash(first)
      ) &&
      state.childEvents.some(
        (item) =>
          item.op === 'api-write' &&
          item.id === 1 &&
          item.state === 'fulfilled' &&
          item.dataSha256 === hash(Buffer.from([0x62]))
      ) &&
      state.peerOutputBytes >= 1 &&
      state.peerOutputHead[0] === 0x62 &&
      state.parentWriteTerminals.get(1) === 'fulfilled'
    await waitFor(
      state,
      () => healthy() || acquisitionRejected() || state.processClose,
      deadline,
      'healthy exchange or acquisition result'
    )
    if (acquisitionRejected()) {
      await waitFor(state, () => physicalJoin(state), deadline, 'acquisition cleanup close')
      state.safeOwnership = physicalJoin(state)
      state.diagnostic = 'PARTIAL'
      return state
    }
    assert(healthy(), 'healthy exchange was not observed')
    if (SOCKET.has(id)) {
      const reverse = Buffer.from([0x63])
      writeParent(state, 'writer4', 2, reverse)
      await waitFor(
        state,
        () =>
          state.childEvents.some(
            (item) => item.op === 'socket-read' && item.endpoint === 'writer4' && item.dataSha256 === hash(reverse)
          ) && state.parentWriteTerminals.get(2) === 'fulfilled',
        deadline,
        'reverse monitor'
      )
    }
    if (BULK.has(id)) {
      state.peer4.pause()
      state.phase = 'setup'
      caseParentRecord(state, 'setup', 'peer-pause', 'writer4', 0, 'requested')
    }
    await sendCommand(state, 'arm', deadline)
    const armRejected = () =>
      state.childEvents.some((item) => item.op === 'goal' && item.id === 2 && item.state === 'rejected')
    await waitFor(
      state,
      () => state.barriers.has('armed') || acquisitionRejected() || armRejected(),
      deadline,
      'armed prerequisites'
    )
    if (armRejected()) {
      durableFrontier(state)
      state.phase = 'rescue'
      await sendCommand(state, 'rescue-destroy', deadline)
      if (BULK.has(id)) await drainBulk(state, deadline)
      await rescueInput(state, deadline)
      await sendCommand(state, 'finish', deadline)
      await waitFor(state, () => physicalJoin(state), deadline, 'unreached prerequisite cleanup')
      state.outcome = 'PREREQUISITE_UNREACHED'
      state.diagnostic = 'PARTIAL'
      state.safeOwnership = physicalJoin(state)
      return state
    }
    assert(state.barriers.has('armed'), 'row did not arm')
    state.phase = 'goal'
    await sendCommand(state, 'goal', deadline)
    await waitFor(
      state,
      () => state.childEvents.some((item) => item.op === 'goal' && ['start', 'rejected'].includes(item.state)),
      deadline,
      'goal admission'
    )
    if (state.childEvents.some((item) => item.op === 'goal' && item.state === 'rejected')) {
      durableFrontier(state)
      state.phase = 'rescue'
      await sendCommand(state, 'rescue-destroy', deadline)
      if (BULK.has(id)) await drainBulk(state, deadline)
      await rescueInput(state, deadline)
      await sendCommand(state, 'finish', deadline)
      await waitFor(state, () => physicalJoin(state), deadline, 'goal refusal cleanup')
      state.outcome = 'PREREQUISITE_UNREACHED'
      state.diagnostic = 'PARTIAL'
      state.safeOwnership = physicalJoin(state)
      return state
    }
    if (id === 'N03' || id === 'N04') {
      assert(caseParentRecord(state, 'goal', 'peer-destroy', 'writer4', 0, 'requested'), 'peer-close edge admission')
      state.peer4.destroy()
      await waitFor(state, () => state.peer4Closed, deadline, 'actual peer4 close')
      await sendCommand(state, 'peer-closed', deadline)
    }
    await waitFor(state, () => state.barriers.has('sample'), deadline, 'immutable sample')
    durableFrontier(state)
    state.phase = 'rescue'
    if (id === 'N03' || id === 'N04') {
      await sendCommand(state, 'rescue-destroy', deadline)
      await waitFor(
        state,
        () => ['reader3', 'writer4'].every((endpoint) => state.closeEnds.has(endpoint)),
        deadline,
        'remaining child endpoints closed'
      )
      await rescueInput(state, deadline)
    } else if (BULK.has(id)) {
      if (state.childEvents.some((item) => item.op === 'goal' && item.id === 2 && item.state === 'rejected'))
        await sendCommand(state, 'rescue-destroy', deadline)
      await drainBulk(state, deadline)
      await rescueInput(state, deadline)
    } else {
      const pendingRead = [...state.nativeStarts.values()].some(
        (item) => item.op === 'fs-read' && !state.nativeCompletions.has(item.id)
      )
      if (pendingRead || !state.peer3Closed) await rescueInput(state, deadline)
    }
    await sendCommand(state, 'finish', deadline)
    await waitFor(state, () => physicalJoin(state), deadline, 'natural child and callback joins')
    state.safeOwnership = physicalJoin(state)
    state.outcome = deriveOutcome(state)
    const footer = state.footer
    const endpointClosed = (endpoint) => {
      const stream = state.childEvents.find((item) => item.op === 'stream-close' && item.endpoint === endpoint)
      const fd = state.childEvents.find(
        (item) =>
          item.op === 'fd-check' &&
          item.endpoint === endpoint &&
          item.state === 'rejected' &&
          item.error?.code === 'EBADF' &&
          item.seq > (stream?.seq ?? Infinity)
      )
      const native =
        SOCKET.has(id) ||
        state.childEvents.some(
          (item) =>
            item.op === 'fs-close' &&
            item.endpoint === endpoint &&
            item.state === 'fulfilled' &&
            item.seq < (stream?.seq ?? Infinity)
        )
      return Boolean(stream && fd && native)
    }
    const closedEpoch =
      state.processExit?.code === 0 &&
      state.processExit?.signal === null &&
      footer?.exitCode === 0 &&
      footer.finalSendCallback === true &&
      footer.finalSendState === 'callback-fulfilled' &&
      footer.issuedSends === footer.completedSends &&
      footer.issuedSends === state.childRecords.length &&
      state.childRecords.at(-1)?.kind === 'final' &&
      state.acks.size === state.commands.size &&
      state.nativeStarts.size === state.nativeCompletions.size &&
      ['reader3', 'writer4'].every(endpointClosed) &&
      state.stderrEnded &&
      (state.peer3Ended ||
        state.parentRecords.some((item) => item.op === 'peer-destroy' && item.endpoint === 'reader3')) &&
      (state.peer4Ended ||
        state.parentRecords.some((item) => item.op === 'peer-destroy' && item.endpoint === 'writer4')) &&
      (() => {
        const position = (predicate) => state.timeline.find((entry) => predicate(entry.item))?.ordinal ?? null
        const processCloseAt = position((item) => item.kind === 'process-terminal' && item.event === 'close')
        return (
          processCloseAt !== null &&
          state.timeline.filter((entry) => entry.item.kind === 'process-terminal' && entry.item.event === 'close')
            .length === 1 &&
          state.parentRecords.filter((item) => item.op === 'ipc-disconnect').length === 1 &&
          ['reader3', 'writer4'].every((endpoint) => {
            const closeAt = position((item) => item.op === 'peer-close' && item.endpoint === endpoint)
            const endAt = position((item) => item.op === 'stream-end' && item.endpoint === endpoint)
            const destroyed = state.parentRecords.some(
              (item) => item.op === 'peer-destroy' && item.endpoint === endpoint
            )
            return (
              state.parentRecords.filter((item) => item.op === 'peer-close' && item.endpoint === endpoint).length ===
                1 &&
              state.parentRecords.filter((item) => item.op === 'stream-end' && item.endpoint === endpoint).length <=
                1 &&
              closeAt !== null &&
              closeAt < processCloseAt &&
              (endAt === null || endAt < closeAt) &&
              (destroyed || (endAt !== null && endAt < closeAt))
            )
          }) &&
          (() => {
            const endAt = position((item) => item.op === 'stream-end' && item.endpoint === 'process')
            const closeAt = position((item) => item.op === 'stream-close' && item.endpoint === 'process')
            return (
              state.parentRecords.filter((item) => item.op === 'stream-end' && item.endpoint === 'process').length ===
                1 &&
              state.parentRecords.filter((item) => item.op === 'stream-close' && item.endpoint === 'process').length ===
                1 &&
              endAt !== null &&
              closeAt !== null &&
              endAt < closeAt &&
              closeAt < processCloseAt
            )
          })()
        )
      })() &&
      state.ipcDisconnected &&
      !state.hasSticky &&
      footer.uncaughtExceptionCount === 0 &&
      footer.unhandledRejectionCount === 0 &&
      !state.stderrOverflow &&
      state.safeOwnership
    state.diagnostic =
      closedEpoch && !['INCOMPLETE_INFRA', 'PREREQUISITE_UNREACHED', 'API_ACQUISITION_REJECTED'].includes(state.outcome)
        ? 'COMPLETE'
        : 'PARTIAL'
    assert(state.parentSendsIssued === state.parentSendsCompleted, 'parent IPC callback join')
    if (state.peerWriteCallbacks !== state.peerWrites) state.diagnostic = 'PARTIAL'
    return state
  } catch (error) {
    state.finalizing = true
    stickyFailure(state, error)
    if (!state.child && state.spawnStarted) {
      try {
        caseParentRecord(state, 'setup', 'spawn', 'process', 0, 'threw', { error: errorProjection(error) })
      } catch (recordError) {
        stickyFailure(state, recordError)
      }
    }
    state.timeout = performance.now() >= deadline
    try {
      state.errors.push(errorProjection(error))
    } catch (projectionFailure) {
      stickyFailure(state, projectionFailure)
    }
    try {
      caseParentRecord(state, state.phase || 'rescue', 'fatal', 'process', 0, 'observed', {
        error: errorProjection(error)
      })
    } catch (recordError) {
      stickyFailure(state, recordError)
    }
    try {
      state.outcome = deriveOutcome(state)
    } catch (outcomeError) {
      stickyFailure(state, outcomeError)
      try {
        state.errors.push(errorProjection(outcomeError))
      } catch (projectionError) {
        stickyFailure(state, projectionError)
      }
    }
    state.diagnostic = 'PARTIAL'
    const attempt = (fn) => {
      try {
        return fn()
      } catch (failure) {
        stickyFailure(state, failure)
        for (const logFailure of logReasons('METIS_N0_CONTAINMENT_FAILURE ', failure)) stickyFailure(state, logFailure)
        return null
      }
    }
    if (state.child && !state.processClose) {
      attempt(() => durableFrontier(state))
      const signal = (name) => {
        const stageStart = performance.now()
        const stageDeadline = Math.min(outerDeadline, stageStart + (name === 'SIGTERM' ? 2000 : 3000))
        state.terminalCutoff = stageDeadline
        attempt(() => caseParentRecord(state, 'rescue', 'infra-term', 'process', 0, 'start'))
        let result = null
        try {
          result = state.child.kill(name)
        } catch (failure) {
          stickyFailure(state, failure)
          attempt(() =>
            caseParentRecord(state, 'rescue', 'fatal', 'process', 0, 'observed', { error: errorProjection(failure) })
          )
        }
        state.signals.push({ name, result })
        if (result !== null)
          attempt(() => caseParentRecord(state, 'rescue', 'infra-term', 'process', 0, 'requested', { result }))
        state.terminated = true
        return stageDeadline
      }
      const termDeadline = signal('SIGTERM')
      try {
        await waitFor(state, () => state.processClose, termDeadline, 'SIGTERM close', true)
      } catch {
        if (!state.processClose) {
          const killDeadline = signal('SIGKILL')
          try {
            await waitFor(state, () => state.processClose, killDeadline, 'SIGKILL close', true)
          } catch {}
        }
      }
    }
    for (const [stream, endpoint] of [
      [state.peer3, 'reader3'],
      [state.peer4, 'writer4']
    ]) {
      if (!stream || stream.destroyed) continue
      attempt(() => caseParentRecord(state, 'rescue', 'peer-destroy', endpoint, 0, 'requested'))
      attempt(() => stream.destroy())
    }
    state.safeOwnership = physicalJoin(state) && performance.now() < state.terminalCutoff
    if (!state.safeOwnership && state.processClose && performance.now() < state.terminalCutoff) {
      try {
        await waitFor(
          state,
          () => physicalJoin(state),
          state.terminalCutoff,
          'contained streams and callback joins',
          true
        )
      } catch {}
      state.safeOwnership = physicalJoin(state) && performance.now() < state.terminalCutoff
    }
    if (!state.child) state.safeOwnership = performance.now() < state.terminalCutoff
    if ((state.child && !state.processClose) || !state.safeOwnership)
      stickyFailure(state, new Error('child ownership or callbacks remain live; stop admissions'))
    return state
  }
}

let collectionPromise = null
function runCollector() {
  collectionPromise ??= Promise.resolve().then(() => runCollectorBody())
  return collectionPromise
}

async function runCollectorBody() {
  const meta = provenance()
  const source = sourceFence(meta)
  source.runtimeExecutableSha256 = await hashExecutable(process.execPath)
  source.run = {
    runId: meta.runId,
    attempt: meta.attempt,
    job: meta.job,
    target: meta.target,
    ref: meta.ref,
    workflowRef: meta.workflowRef
  }
  const directory = runnerDirectory(meta)
  const registry = { handles: new Map(), failures: [], root: null, directory }
  let exitOwnerInstalled = false
  process.on('exit', () => {
    if (exitOwnerInstalled) return
    const previousFailures = registry.failures.length
    closeArtifactRegistry(registry)
    for (const failure of registry.failures.slice(0, previousFailures))
      registry.failures.push(...logReasons('METIS_N0_EARLY_OWNER_FAILURE ', failure))
    for (const failure of registry.failures.slice(previousFailures))
      registry.failures.push(...logReasons('METIS_N0_EARLY_CLOSE_FAILURE ', failure))
    process.exitCode = 2
  })
  const artifacts = createArtifacts(directory, meta, registry)
  const acquisition = acquiredCustody(artifacts, source)
  const globalOrdinal = { ordinal: 0, seq: 0 }
  const results = []
  let outerDeadline = null
  let active = null
  let uncaughtExceptionCount = 0
  let unhandledRejectionCount = 0
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    uncaughtExceptionCount++
    if (origin === 'unhandledRejection') unhandledRejectionCount++
    if (active) {
      stickyFailure(active, error)
    }
    if (active?.child && !active.processClose && !active.finalizing) {
      active.finalizing = true
      const retain = (fn) => {
        try {
          fn()
        } catch (failure) {
          stickyFailure(active, failure)
          for (const logFailure of logReasons('METIS_N0_MONITOR_CONTAINMENT_FAILURE ', failure))
            stickyFailure(active, logFailure)
        }
      }
      retain(() => durableFrontier(active))
      retain(() =>
        caseParentRecord(active, 'rescue', 'fatal', 'process', 0, 'observed', { error: errorProjection(error) })
      )
      retain(() => caseParentRecord(active, 'rescue', 'infra-term', 'process', 0, 'start'))
      let result = null
      try {
        result = active.child.kill('SIGTERM')
      } catch (failure) {
        stickyFailure(active, failure)
        for (const logFailure of logReasons('METIS_N0_MONITOR_SIGNAL_FAILURE ', failure))
          stickyFailure(active, logFailure)
      }
      active.signals.push({ name: 'SIGTERM', result })
      active.terminated = true
      if (result !== null)
        retain(() => caseParentRecord(active, 'rescue', 'infra-term', 'process', 0, 'requested', { result }))
    }
  })
  let exitFooterWritten = false
  process.on('exit', (code) => {
    if (exitFooterWritten || !artifacts.handles.has('parent.events.ndjson')) return
    for (const [name, handle] of artifacts.handles) {
      if (name === 'parent.events.ndjson' || handle.closeAttempted) continue
      try {
        artifacts.closeAndHash(name)
      } catch (error) {
        retainExitFailure(artifacts, 'METIS_N0_ARTIFACT_CLOSE_FAILURE ', error)
      }
    }
    const footer = {
      v: 1,
      kind: 'exit-footer',
      caseId: null,
      issuedSends: results.reduce((sum, state) => sum + (state.parentSendsIssued || 0), 0),
      completedSends: results.reduce((sum, state) => sum + (state.parentSendsCompleted || 0), 0),
      finalSendCallback: null,
      finalSendState: null,
      finalSendError: null,
      uncaughtExceptionCount,
      unhandledRejectionCount,
      exitCode: code
    }
    try {
      const payload = JSON.stringify(footer)
      const line = JSON.stringify({ ordinal: ++globalOrdinal.ordinal, origin: 'parent', payload }) + '\n'
      artifacts.append('parent.events.ndjson', Buffer.from(line))
      artifacts.closeAndHash('parent.events.ndjson')
      exitFooterWritten = true
      if (collectionClosed && !artifacts.failures.length && !active) {
        const custody = closedCustody(artifacts, acquisition)
        emitWorkflowOutputs({ owned_collection_closed: true, custody: custodyText(custody) })
      }
    } catch (error) {
      retainExitFailure(artifacts, 'METIS_N0_PARENT_FOOTER_FAILURE ', error)
      try {
        artifacts.closeAndHash('parent.events.ndjson')
      } catch (closeError) {
        retainExitFailure(artifacts, 'METIS_N0_PARENT_CLOSE_FAILURE ', closeError)
      }
    }
  })
  exitOwnerInstalled = true
  let stop = false
  let collectionClosed = false
  for (const id of IDS) {
    if (outerDeadline !== null && performance.now() + 5000 >= outerDeadline) stop = true
    if (stop) {
      const state = makeCaseState(id, artifacts, meta)
      state.outcome = 'INCOMPLETE_INFRA'
      state.diagnostic = 'PARTIAL'
      results.push(state)
      await finalizeCase(state)
      continue
    }
    const state = makeCaseState(id, artifacts, meta)
    results.push(state)
    active = state
    if (outerDeadline === null) outerDeadline = performance.now() + 150000
    try {
      await runOneCase(state, globalOrdinal, source, outerDeadline)
    } catch (error) {
      stickyFailure(state, error)
      try {
        state.errors.push(errorProjection(error))
      } catch (projectionFailure) {
        stickyFailure(state, projectionFailure)
      }
    }
    await finalizeCase(state)
    if (
      state.safeOwnership &&
      performance.now() < state.terminalCutoff &&
      artifacts.failures.length === 0 &&
      namesFor(id).every((name) => artifacts.hashes.has(name))
    ) {
      active = null
      globalParentRecord(artifacts, globalOrdinal, {
        v: 1,
        kind: 'parent',
        caseId: null,
        seq: ++globalOrdinal.seq,
        phase: 'finish',
        op: 'case-release',
        endpoint: 'process',
        id: IDS.indexOf(id) + 1,
        state: 'observed',
        bytes: null,
        dataSha256: null,
        result: null,
        error: null,
        childSeq: null
      })
    } else stop = true
  }
  const cases = results.map((state) => collectorCaseRow(state, artifacts))
  const allAttempted = cases.every((item) => item.attempted)
  const allComplete = allAttempted && cases.every((item) => item.diagnosticStatus === 'COMPLETE')
  const collector = {
    schema: SCHEMA,
    base: BASE,
    source,
    run: source.run,
    roster: IDS.map((id, index) => ({ id, name: NAMES[index] })),
    cases,
    diagnosticStatus: allComplete ? 'COMPLETE' : 'PARTIAL',
    safeToUpload: false,
    rawFiles: {
      parent: { path: 'parent.events.ndjson', size: artifacts.sizes.get('parent.events.ndjson'), sha256: null },
      collector: { path: 'collector.json', size: null, sha256: null },
      cases: Object.fromEntries(
        IDS.flatMap(namesFor).map((name) => [
          name,
          { size: artifacts.sizes.get(name), sha256: artifacts.hashes.get(name) ?? null }
        ])
      )
    },
    custody: acquisition
  }
  let collectorSize = 0
  let finalizedCollectorBytes
  for (let attempt = 0; attempt < 4; attempt++) {
    collector.rawFiles.collector.size = collectorSize
    finalizedCollectorBytes = boundedJson(collector, MAX_META)
    if (collectorSize === finalizedCollectorBytes.length) break
    collectorSize = finalizedCollectorBytes.length
  }
  assert(
    collector.rawFiles.collector.size === finalizedCollectorBytes.length,
    'collector manifest size did not converge'
  )
  artifacts.append('collector.json', finalizedCollectorBytes)
  artifacts.closeAndHash('collector.json')
  collectionClosed =
    artifacts.failures.length === 0 &&
    results.every((state) => !state.attempted || state.safeOwnership) &&
    IDS.flatMap(namesFor).every((name) => artifacts.hashes.has(name)) &&
    artifacts.hashes.has('collector.json')
  if (!allComplete || stop) process.exitCode = 1
}
async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--collect') return runCollector()
  if (args.length === 1 && args[0] === '--replay') return runReplay()
  if (args.length === 1 && args[0] === '--record-exit') return recordCollectorExit()
  if (args.length === 1 && args[0] === '--admit-upload') return admitUpload()
  if (args.length === 2 && args[0] === '--child' && IDS.includes(args[1])) return runChild(args[1])
  throw new Error('explicit fixed N0 mode required')
}

const fatalOutputFailures = []
main().catch((error) => {
  try {
    for (const reason of error instanceof AggregateError ? error.errors : [error])
      writeAll(2, Buffer.from('METIS_N0_FATAL ' + String(reason?.stack || reason).slice(0, 2048) + '\n'))
  } catch (failure) {
    fatalOutputFailures.push(error, failure)
  }
  process.exitCode = process.argv[2] === '--collect' ? 2 : 1
})
