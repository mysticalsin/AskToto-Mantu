#!/usr/bin/env node
/**
 * One content-free observation of the running app for `run-matrix.sh --hosted-live` (M2-0462).
 *
 * Connects to the app's DevTools endpoint (the launch passes --remote-debugging-port), times a renderer
 * round trip on every page, asks the main process to answer through the preload bridge
 * (window.toto.brainStatus, an IPC round trip), optionally drives the row's action, and derives the row's
 * operator_result from those observations alone. Every evaluated expression returns only a boolean or
 * document.visibilityState, never meeting data, and error text is never copied into the output.
 *
 * Usage: node cdp-observe.mjs --port <n> --row <row id> --drive none|history|brain-status [--timeout-ms 10000]
 * Prints one JSON line and exits 0: an unreachable DevTools endpoint is an observation too, and the
 * derived result then says the row was not exercised.
 */
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

// History's open path lists meetings (recallList); brainStatus is what the History/Brain view polls.
export const DRIVE_EXPRESSIONS = Object.freeze({
  none: null,
  history: 'window.toto.recallList().then(() => true)',
  'brain-status': 'window.toto.brainStatus().then(() => true)'
})
export const PAGE_PROBE =
  "({ bridge: typeof window.toto?.brainStatus === 'function' && typeof window.toto?.recallList === 'function', visible: document.visibilityState === 'visible' })"
export const MAIN_PROBE = 'window.toto.brainStatus().then(() => true)'
export const VISIBILITY_OBSERVED_BY = 'cdp:document.visibilityState'
const REOPEN_ROWS = new Set(['row-3-macos-activate', 'row-4-second-instance-reopen'])

/** Settles with `{ outcome: 'answered' | 'error' | 'timeout', value? }`; never rejects. */
function bounded(promise, ms) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ outcome: 'timeout' }), ms)
  })
  return Promise.race([
    promise.then((value) => ({ outcome: 'answered', value }), () => ({ outcome: 'error' })),
    timeout
  ]).finally(() => clearTimeout(timer))
}

function cdpClient(wsUrl) {
  const socket = new WebSocket(wsUrl)
  const pending = new Map()
  let nextId = 1
  socket.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(String(event.data))
    } catch {
      return
    }
    const resolve = pending.get(message.id)
    if (!resolve) return
    pending.delete(message.id)
    resolve(message)
  })
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', () => reject(new Error('socket failed')))
  })
  ready.catch(() => {})
  async function evaluate(expression) {
    await ready
    const id = nextId++
    const answer = new Promise((resolve) => pending.set(id, resolve))
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    const message = await answer
    if (message.error || message.result?.exceptionDetails) throw new Error('evaluation failed')
    return message.result?.result?.value
  }
  return { evaluate, close: () => socket.close() }
}

/** The worst outcome across pages: one timed-out page is a stalled renderer. */
function worst(outcomes) {
  if (outcomes.includes('timeout')) return 'timeout'
  if (outcomes.includes('error')) return 'error'
  return outcomes.length > 0 ? 'answered' : 'not-run'
}

/**
 * @param {{port: number, drive: keyof typeof DRIVE_EXPRESSIONS, timeoutMs: number}} args
 */
export async function observe({ port, drive, timeoutMs }) {
  const cdp = {
    reachable: false,
    page_targets: 0,
    renderer_round_trip: 'not-run',
    renderer_round_trip_ms: null,
    main_round_trip: 'not-run',
    main_answered: false,
    drive: drive === 'none' ? 'none' : 'not-run',
    window_visible: null,
    window_visible_observed_by: VISIBILITY_OBSERVED_BY
  }
  const list = await bounded(fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()), timeoutMs)
  if (list.outcome !== 'answered' || !Array.isArray(list.value)) return cdp
  cdp.reachable = true
  const pages = list.value.filter((target) => target?.type === 'page' && typeof target.webSocketDebuggerUrl === 'string')
  cdp.page_targets = pages.length

  const clients = []
  const outcomes = []
  let bridgeClient = null
  let slowestMs = 0
  let visible = false
  try {
    for (const page of pages) {
      const client = cdpClient(page.webSocketDebuggerUrl)
      clients.push(client)
      const started = performance.now()
      const probe = await bounded(client.evaluate(PAGE_PROBE), timeoutMs)
      slowestMs = Math.max(slowestMs, Math.round(performance.now() - started))
      outcomes.push(probe.outcome)
      if (probe.outcome !== 'answered') continue
      if (probe.value?.visible === true) visible = true
      if (probe.value?.bridge === true && !bridgeClient) bridgeClient = client
    }
    cdp.renderer_round_trip = worst(outcomes)
    if (outcomes.length > 0) cdp.renderer_round_trip_ms = slowestMs
    if (outcomes.includes('answered')) cdp.window_visible = visible

    if (!bridgeClient) {
      if (pages.length > 0) {
        cdp.main_round_trip = 'no-bridge'
        if (drive !== 'none') cdp.drive = 'no-bridge'
      }
      return cdp
    }
    const main = await bounded(bridgeClient.evaluate(MAIN_PROBE), timeoutMs)
    cdp.main_round_trip = main.outcome === 'answered' && main.value !== true ? 'error' : main.outcome
    cdp.main_answered = cdp.main_round_trip === 'answered'
    const expression = DRIVE_EXPRESSIONS[drive]
    if (expression) {
      const driven = await bounded(bridgeClient.evaluate(expression), timeoutMs)
      cdp.drive = driven.outcome === 'answered' && driven.value !== true ? 'error' : driven.outcome
    }
    return cdp
  } finally {
    for (const client of clients) client.close()
  }
}

/**
 * The row's operator_result, from observations only. `observed` means the owner bug's symptom was seen
 * (a round trip that never answered, or no visible window after a reopen request); `pass` means every
 * round trip answered and nothing froze; `not-exercised` means the row could not be observed at all.
 */
export function deriveRowResult(row, cdp) {
  if (!cdp.reachable || cdp.page_targets === 0) {
    return { operator_result: 'not-exercised', symptom_observed: null, reason: 'devtools-unreachable' }
  }
  const outcomes = [cdp.renderer_round_trip, cdp.main_round_trip, ...(cdp.drive === 'none' ? [] : [cdp.drive])]
  if (outcomes.includes('timeout')) {
    return { operator_result: 'observed', symptom_observed: true, reason: 'round-trip-timeout' }
  }
  if (outcomes.some((outcome) => outcome !== 'answered')) {
    return { operator_result: 'not-exercised', symptom_observed: null, reason: 'round-trip-not-answered' }
  }
  if (REOPEN_ROWS.has(row) && cdp.window_visible !== true) {
    return { operator_result: 'observed', symptom_observed: true, reason: 'no-visible-window' }
  }
  return { operator_result: 'pass', symptom_observed: false, reason: 'all-round-trips-answered' }
}

async function main() {
  const { values } = parseArgs({
    options: {
      port: { type: 'string' },
      row: { type: 'string' },
      drive: { type: 'string', default: 'none' },
      'timeout-ms': { type: 'string', default: '10000' }
    }
  })
  const port = Number(values.port)
  const timeoutMs = Number(values['timeout-ms'])
  if (!Number.isInteger(port) || port <= 0 || !Number.isInteger(timeoutMs) || timeoutMs <= 0 ||
      !values.row || !Object.hasOwn(DRIVE_EXPRESSIONS, values.drive)) {
    console.error('usage: cdp-observe.mjs --port <n> --row <row id> --drive none|history|brain-status [--timeout-ms <n>]')
    process.exit(2)
  }
  const cdp = await observe({ port, drive: values.drive, timeoutMs })
  // operator_result is the first key: run-matrix.sh reads it off the front of this line.
  printAndExit({ ...deriveRowResult(values.row, cdp), cdp })
}

/** A hung evaluation leaves its socket and promise pending; once the line is flushed (pipes are
 *  asynchronous on macOS), the observation is complete, so exit. */
function printAndExit(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    printAndExit({ operator_result: 'not-exercised', symptom_observed: null, reason: 'observer-error', cdp: null })
  })
}
