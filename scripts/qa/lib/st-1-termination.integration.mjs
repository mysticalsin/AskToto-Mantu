import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { stopOwnedChild } from './st-1-termination.mjs'

const TOTAL_MS = 20_000
const REASONS = new Set([
  'ok',
  'host-admission',
  'unsupported-platform',
  'spawn-failed',
  'readiness-timeout',
  'invalid-readiness',
  'ipc-failed',
  'root-not-live',
  'descendant-not-live',
  'group-not-live',
  'probe-permission',
  'probe-error',
  'helper-unacknowledged',
  'root-exit-unobserved',
  'descendant-still-present',
  'overall-timeout',
  'unexpected'
])
const PLATFORMS = new Set(['linux', 'win32'])
const CLEANUP = new Set(['not-needed', 'acknowledged', 'unacknowledged'])
const exited = (child) => child.exitCode != null || child.signalCode != null
const now = () => performance.now()
const safePid = (pid) => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid
const exact = (value, keys) =>
  value != null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key))

/** Fixed public fields only: never serialize errors, PIDs, paths, nonces or child output. */
export function fixtureReceipt(reason, platform, durationMs, cleanup) {
  const clean = CLEANUP.has(cleanup) ? cleanup : 'unacknowledged'
  const validPass = clean === 'not-needed' && PLATFORMS.has(platform)
  const label = REASONS.has(reason) && (reason !== 'ok' || validPass) ? reason : 'unexpected'
  return {
    schema: 'st1-owned-termination-v1',
    verdict: label === 'ok' ? 'PASS' : 'FAIL',
    reason: label,
    platform: PLATFORMS.has(platform) ? platform : 'unsupported',
    durationMs: Number.isFinite(durationMs) ? Math.min(TOTAL_MS, Math.max(0, Math.ceil(durationMs))) : TOTAL_MS,
    cleanup: clean
  }
}

// Serialized constant fixture code. The nonce travels only through the two private IPC channels.
function ownedRoot() {
  const { spawn } = require('node:child_process')
  const sameKeys = (message, keys) =>
    message != null &&
    typeof message === 'object' &&
    Object.keys(message).length === keys.length &&
    keys.every((key) => Object.hasOwn(message, key))
  let nonce
  let child
  let stopping = false
  const expire = setTimeout(() => process.exit(1), 30_000)
  const stopRoot = () => {
    clearTimeout(expire)
    process.send({ kind: 'stopped', nonce }, () => process.exit(0))
  }
  process.on('error', () => process.exit(1))
  process.on('message', (message) => {
    if (!sameKeys(message, ['kind', 'nonce'])) return process.exit(1)
    if (message.kind === 'shutdown' && nonce && message.nonce === nonce) {
      stopping = true
      if (child.exitCode != null || child.signalCode != null) return stopRoot()
      if (!child.connected) return process.exit(1)
      child.send(message, (error) => {
        if (error) process.exit(1)
      })
      return
    }
    if (message.kind !== 'challenge' || nonce || !/^[a-f0-9]{64}$/.test(message.nonce)) return process.exit(1)
    nonce = message.nonce
    function ownedDescendant() {
      let nonce
      setTimeout(() => process.exit(1), 30_000)
      process.on('error', () => process.exit(1))
      process.on('message', (message) => {
        if (
          !message ||
          Object.keys(message).length !== 2 ||
          !Object.hasOwn(message, 'kind') ||
          !Object.hasOwn(message, 'nonce')
        ) {
          process.exit(1)
          return
        }
        if (message.kind === 'challenge' && !nonce && /^[a-f0-9]{64}$/.test(message.nonce)) {
          nonce = message.nonce
          process.send({ kind: 'ready', nonce, pid: process.pid }, (error) => {
            if (error) process.exit(1)
          })
        } else if (message.kind === 'shutdown' && nonce && message.nonce === nonce) {
          process.exit(0)
        } else {
          process.exit(1)
        }
      })
    }
    try {
      child = spawn(process.execPath, ['-e', `(${ownedDescendant.toString()})()`], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true
      })
      child.on('error', () => process.exit(1))
      child.on('exit', () => {
        if (stopping) stopRoot()
        else process.exit(1)
      })
      child.on('message', (ready) => {
        if (
          !sameKeys(ready, ['kind', 'nonce', 'pid']) ||
          ready.kind !== 'ready' ||
          ready.nonce !== nonce ||
          ready.pid !== child.pid
        ) {
          process.exit(1)
          return
        }
        process.send({ kind: 'ready', nonce, rootPid: process.pid, descendantPid: child.pid }, (error) => {
          if (error) process.exit(1)
        })
      })
      child.send({ kind: 'challenge', nonce }, (error) => {
        if (error) process.exit(1)
      })
    } catch {
      process.exit(1)
    }
  })
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error?.code === 'EPERM' ? 'probe-permission' : 'probe-error'
  }
}

function exchange(child, message, valid, deadline) {
  return new Promise((resolve, reject) => {
    const finish = (reason, value) => {
      clearTimeout(timer)
      child.removeListener('message', received)
      child.removeListener('error', failed)
      child.removeListener('exit', gone)
      if (reason) reject(reason)
      else resolve(value)
    }
    const received = (value) => {
      if (now() >= deadline) finish('readiness-timeout')
      else if (!valid(value)) finish('invalid-readiness')
      else finish(null, value)
    }
    const failed = () => finish('ipc-failed')
    const gone = () => finish('root-not-live')
    const timer = setTimeout(() => finish('readiness-timeout'), Math.max(0, deadline - now()))
    child.on('message', received)
    child.on('error', failed)
    child.on('exit', gone)
    try {
      child.send(message, (error) => {
        if (error) failed()
      })
    } catch {
      failed()
    }
  })
}

async function observeUntil(predicate, deadline) {
  while (now() < deadline) {
    const observed = predicate()
    if (now() >= deadline) break
    if (observed) return true
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(0, deadline - now()))))
  }
  return false
}

async function recover(child, nonce, descendantPid, deadline) {
  if (!child.connected || exited(child) || now() >= deadline) return 'unacknowledged'
  try {
    await exchange(
      child,
      { kind: 'shutdown', nonce },
      (message) => exact(message, ['kind', 'nonce']) && message.kind === 'stopped' && message.nonce === nonce,
      deadline
    )
    return (await observeUntil(() => exited(child) && (!descendantPid || !alive(descendantPid)), deadline))
      ? 'acknowledged'
      : 'unacknowledged'
  } catch {
    return 'unacknowledged'
  }
}

export async function runHostedFixture() {
  const started = now()
  const overallDeadline = started + TOTAL_MS
  const receipt = (reason, cleanup) => fixtureReceipt(reason, process.platform, now() - started, cleanup)
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    process.env.METIS_FIXTURE_RUNNER_ENVIRONMENT !== 'github-hosted'
  ) {
    return receipt('host-admission', 'not-needed')
  }
  if (!PLATFORMS.has(process.platform)) return receipt('unsupported-platform', 'not-needed')

  let child
  let descendantPid
  let childError = false
  let reason = 'unexpected'
  let nonce
  const recordError = () => {
    childError = true
  }
  try {
    nonce = randomBytes(32).toString('hex')
    const spawnAt = now()
    try {
      child = spawn(process.execPath, ['-e', `(${ownedRoot.toString()})()`], {
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true
      })
    } catch {
      throw 'spawn-failed'
    }
    child.on('error', recordError)
    if (!safePid(child.pid)) throw 'spawn-failed'
    const ready = await exchange(
      child,
      { kind: 'challenge', nonce },
      (message) =>
        exact(message, ['kind', 'nonce', 'rootPid', 'descendantPid']) &&
        message.kind === 'ready' &&
        message.nonce === nonce &&
        message.rootPid === child.pid &&
        safePid(message.descendantPid) &&
        message.descendantPid !== child.pid,
      spawnAt + 5_000
    )
    descendantPid = ready.descendantPid
    if (exited(child) || !alive(child.pid)) throw 'root-not-live'
    if (!alive(descendantPid)) throw 'descendant-not-live'
    if (process.platform !== 'win32' && !alive(-child.pid)) throw 'group-not-live'
    if (childError) throw 'ipc-failed'
    if (now() >= spawnAt + 5_000) throw 'readiness-timeout'

    const stopped = await stopOwnedChild(child)
    if (!exact(stopped, ['state']) || stopped.state !== 'acknowledged') throw 'helper-unacknowledged'
    if (!exited(child)) throw 'root-exit-unobserved'
    if (!(await observeUntil(() => !alive(descendantPid), Math.min(overallDeadline, now() + 5_000)))) {
      throw 'descendant-still-present'
    }
    if (childError) throw 'ipc-failed'
    if (now() >= overallDeadline) throw 'overall-timeout'
    reason = 'ok'
  } catch (error) {
    reason = typeof error === 'string' && REASONS.has(error) ? error : 'unexpected'
  }
  let cleanup = 'not-needed'
  if (reason !== 'ok' && child) {
    cleanup = await recover(child, nonce, descendantPid, Math.min(overallDeadline, now() + 2_000))
  }
  child?.removeListener('error', recordError)
  return receipt(reason, cleanup)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const started = now()
  let finished = false
  const finish = (receipt) => {
    if (finished) return
    finished = true
    clearTimeout(deadline)
    process.stdout.write(`${JSON.stringify(receipt)}\n`, () => process.exit(receipt.verdict === 'PASS' ? 0 : 1))
  }
  const unexpected = () => finish(fixtureReceipt('unexpected', process.platform, now() - started, 'unacknowledged'))
  const deadline = setTimeout(
    () => finish(fixtureReceipt('overall-timeout', process.platform, TOTAL_MS, 'unacknowledged')),
    TOTAL_MS
  )
  process.on('uncaughtException', unexpected)
  process.on('unhandledRejection', unexpected)
  runHostedFixture().then(finish, unexpected)
}
