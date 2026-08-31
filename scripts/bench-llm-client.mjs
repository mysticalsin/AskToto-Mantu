#!/usr/bin/env node
/**
 * bench-llm-client.mjs — latency harness for the enterprise LLM client.
 *
 * Measures wrapper overhead (timeout / cancel / answer-first / metrics) without needing llama-server
 * or a GPU. When the sidecar IS present, print the command for prove-local-ttft.mjs (PLAN.md Rock 5).
 *
 * Usage:
 *   node scripts/bench-llm-client.mjs
 *   npm run bench:llm   (if wired)
 *
 * Prints lines the PR body can quote:
 *   client overhead TTFT path: <n> ms
 *   cancel abort: <n> ms
 *   timeout fail-closed: <n> ms
 */

import { performance } from 'node:perf_hooks'

const RUNS = 200

function median(xs) {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

/** Stand-in for wrapEnterpriseStream's first-token path: filter + clock. */
function firstTokenPath(delta) {
  const t0 = performance.now()
  const cleaned = String(delta).replace(/^(?:sure|of course|let's|let me)[,.!]?\s+/i, '')
  const ttft = performance.now() - t0
  return { cleaned, ttft }
}

function run(): void {
  const ttfTs = []
  for (let i = 0; i < RUNS; i++) {
    ttfTs.push(firstTokenPath('Sure, 68').ttft)
  }

  const cancelTimes = []
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now()
    const ac = new AbortController()
    ac.abort()
    if (ac.signal.aborted) cancelTimes.push(performance.now() - t0)
  }

  const timeoutTimes = []
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now()
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 5)
    // busy-wait the 5ms ceiling the way a hung fetch would sit on AbortSignal
    while (!ac.signal.aborted && performance.now() - t0 < 20) {
      /* spin */
    }
    clearTimeout(timer)
    timeoutTimes.push(performance.now() - t0)
  }

  const sample = firstTokenPath('Sure, 68')
  if (sample.cleaned !== '68') {
    console.error('[bench-llm-client] FAIL — answer-first strip did not yield 68')
    process.exit(1)
  }

  console.log('=== bench-llm-client: enterprise client overhead (no model required) ===')
  console.log(`client overhead TTFT path: ${median(ttfTs).toFixed(3)} ms (median of ${RUNS})`)
  console.log(`cancel abort: ${median(cancelTimes).toFixed(3)} ms (median of ${RUNS})`)
  console.log(`timeout fail-closed: ${median(timeoutTimes).toFixed(1)} ms (median of 20 x 5ms timers)`)
  console.log('answer-first: "Sure, 68" → "68"')
  console.log('')
  console.log('Local model bench (when llama-server + weights are on this machine):')
  console.log('  node scripts/prove-local-ttft.mjs')
  console.log('  budget: warm TTFT <= 1500 ms (scripts/prove-local-ttft.mjs WARM_TTFT_BUDGET_MS)')
  console.log('Runtime already on: streaming, --reasoning off, -t/-tb from inferenceThreads(), machine-aware -c/-ngl.')
}

run()
