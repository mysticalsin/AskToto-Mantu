import { pinnedExpression, releaseExpression, sampleExpression, withTimeout } from './st-1-core.mjs'

export const INSPECTOR_WAIT_MS = 60_000
export const EVALUATE_TIMEOUT_MS = 5_000
export const EVALUATE_MARGIN_MS = 2_000
export const LOOP_RESOLUTION_MS = 10
export const SAMPLE_TIMEOUT_MS = 4_000
export const SETUP_TIMEOUT_MS = 5_000

export const MAIN_LOOP_SETUP = `(() => {
  const { monitorEventLoopDelay } = process.getBuiltinModule('node:perf_hooks')
  globalThis.__st1 = monitorEventLoopDelay({ resolution: ${LOOP_RESOLUTION_MS} })
  globalThis.__st1.enable()
  globalThis.__st1lastRunLoopMaxMs = __st1.max / 1e6
  globalThis.__st1since = monitorEventLoopDelay({ resolution: ${LOOP_RESOLUTION_MS} })
  globalThis.__st1since.enable()
  return process.env.UV_THREADPOOL_SIZE ?? 'default'
})()`

export const MAIN_LOOP_SUMMARY = '({ p99Ms: __st1.percentile(99) / 1e6, maxMs: __st1.max / 1e6 })'

export async function inspectorUrlFromChild(child, waitMs = INSPECTOR_WAIT_MS) {
  let stderr = ''
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      child.stderr?.off('data', onData)
      child.off('error', onError)
      child.off('exit', onExit)
    }
    const onData = (chunk) => {
      stderr += String(chunk)
      const match = /ws:\/\/127\.0\.0\.1:\d+\/[\w-]+/.exec(stderr)
      if (match) {
        cleanup()
        resolve(match[0])
      }
    }
    const onError = (error) => {
      cleanup()
      reject(new Error(`candidate failed to start: ${error.message}`))
    }
    const onExit = (code) => {
      cleanup()
      reject(new Error(`candidate exited before the inspector was ready (code ${code})`))
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('no main-process inspector: the EnableNodeCliInspectArguments fuse may be off'))
    }, waitMs)
    child.stderr?.on('data', onData)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

export function mainInspector(wsUrl) {
  const socket = new WebSocket(wsUrl)
  const pending = new Map()
  let nextId = 1
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const resolve = pending.get(message.id)
    if (!resolve) return
    pending.delete(message.id)
    resolve(message)
  })
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', () => reject(new Error('main-process inspector socket failed to connect')))
  })
  ready.catch(() => {})

  async function send(method, params = {}, timeoutMs = EVALUATE_TIMEOUT_MS) {
    await ready
    const id = nextId++
    const answer = new Promise((resolve) => pending.set(id, resolve))
    socket.send(JSON.stringify({ id, method, params }))
    const outcome = await withTimeout(answer, timeoutMs)
    if (!outcome.ok) {
      pending.delete(id)
      return { late: true }
    }
    if (outcome.value.error) throw new Error(`${method}: ${outcome.value.error.message}`)
    return { late: false, result: outcome.value.result }
  }

  async function evaluate(expression, timeoutMs = EVALUATE_TIMEOUT_MS) {
    const answer = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs)
    if (answer.late) return answer
    if (answer.result.exceptionDetails) throw new Error(answer.result.exceptionDetails.text)
    return { late: false, value: answer.result.result?.value }
  }

  return { send, evaluate, close: () => socket.close() }
}

let nextEvaluationKey = 0

export async function evaluateBounded(cdp, step, expression, ms) {
  const key = `${step}-${nextEvaluationKey++}`
  const started = performance.now()
  let outcome
  try {
    const answer = await cdp.evaluate(pinnedExpression(key, expression, ms), ms + EVALUATE_MARGIN_MS)
    outcome = answer.late ? { ok: false, timedOut: true } : answer.value
  } catch (error) {
    outcome = { ok: false, error: error.message }
  }
  cdp.send('Runtime.evaluate', { expression: releaseExpression(key) }, EVALUATE_TIMEOUT_MS).catch(() => {})
  return { ...outcome, elapsedMs: performance.now() - started }
}

export async function setupMainLoopMonitor(cdp) {
  return evaluateBounded(cdp, 'setup', MAIN_LOOP_SETUP, SETUP_TIMEOUT_MS)
}

export async function sampleMainLoop(cdp, probeFile) {
  return evaluateBounded(cdp, 'sample', sampleExpression(probeFile), SAMPLE_TIMEOUT_MS)
}

export async function summarizeMainLoop(cdp) {
  return evaluateBounded(cdp, 'summary', MAIN_LOOP_SUMMARY, SETUP_TIMEOUT_MS)
}
