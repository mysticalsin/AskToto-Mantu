/**
 * MQA-285 — Listen click-to-transcript must be immediate.
 *
 * Diagnosis (locked): start() awaited ASR/IPC (setListeningState, parakeetEnsure, getAsrBundled)
 * BEFORE acquireMic(), so the click gesture and the first second of audio were spent behind a
 * model/IPC round trip. Prewarm was delayed 4s and then idle-unloaded the hot engine after 3 min,
 * so the next Listen (or a click before the delay finished) paid a cold start. Recap waited on
 * that same drain/cold-start path.
 *
 * There is no jsdom harness for useListen, so this pins the source-observable contract:
 * same-turn mic capture, app-ready prewarm, no idle-unload of a hot engine.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = readFileSync(join(__dirname, 'listen.ts'), 'utf8').replace(/\r\n/g, '\n')
const APP = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8').replace(/\r\n/g, '\n')

function blockBetween(src: string, from: string, to: string): string {
  const start = src.indexOf(from)
  expect(start, `marker not found: ${from}`).toBeGreaterThan(-1)
  const end = src.indexOf(to, start)
  expect(end, `end marker not found after ${from}: ${to}`).toBeGreaterThan(-1)
  return src.slice(start, end)
}

/** Drop `//` comments so order assertions cannot fire on the prose that documents the contract. */
function codeOnly(s: string): string {
  return s
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

const startBody = codeOnly(blockBetween(SRC, 'const start = useCallback(', 'const closeChannel = useCallback'))
const prewarm = codeOnly(blockBetween(SRC, '// MQA-285: prewarm at app ready', '// Mid-session spoken-language change'))
const finishTeardown = codeOnly(blockBetween(SRC, 'const finishTeardown = (): void => {', 'const waitForDrain = (): void => {'))
const endReview = codeOnly(blockBetween(APP, 'const endReview = useCallback(', 'const toggleListen = useCallback('))

describe('MQA-285 — same-turn capture: acquireMic before any await in start()', () => {
  it('kicks acquireMic() before the first await so the click gesture covers getUserMedia', () => {
    const micKick = startBody.search(/acquireMic\(/)
    const firstAwait = startBody.search(/\bawait\s/)
    expect(micKick).toBeGreaterThan(-1)
    expect(firstAwait).toBeGreaterThan(-1)
    expect(micKick).toBeLessThan(firstAwait)
  })

  it('does not await setListeningState, parakeetStatus, parakeetEnsure, or getAsrBundled before kicking the mic', () => {
    const micKick = startBody.search(/acquireMic\(/)
    expect(micKick).toBeGreaterThan(-1)
    const beforeMic = startBody.slice(0, micKick)
    expect(beforeMic).not.toMatch(/await window\.toto\.setListeningState/)
    expect(beforeMic).not.toMatch(/await window\.toto\.parakeetStatus/)
    expect(beforeMic).not.toMatch(/await window\.toto\.parakeetEnsure/)
    expect(beforeMic).not.toMatch(/await getAsrBundled/)
  })

  it('keeps pumping queued windows once ASR reports ready so the first second is not dropped', () => {
    expect(SRC).toMatch(/pump\(\) \/\/ drain windows captured while the model loaded/)
    expect(startBody).toMatch(/if \(readyRef\.current\) pump\(\)/)
  })
})

describe('MQA-285 — prewarm at app ready, keep a hot engine', () => {
  it('prewarms immediately, not after a 4s delay or requestIdleCallback', () => {
    expect(prewarm).not.toMatch(/setTimeout\([^,]+,\s*4000\)/)
    expect(prewarm).not.toMatch(/requestIdleCallback/)
    expect(prewarm).toMatch(/void warm\(\)/)
  })

  it('does not idle-unload the prewarmed worker', () => {
    expect(prewarm).not.toMatch(/WORKER_IDLE_RELEASE_MS/)
    expect(prewarm).not.toMatch(/workerRef\.current\?\.terminate\(\)/)
  })

  it('prewarms Parakeet when that engine is configured, Whisper otherwise', () => {
    expect(prewarm).toMatch(/asrEngine === 'parakeet'/)
    expect(prewarm).toMatch(/parakeetEnsure/)
    expect(prewarm).toMatch(/ensureWorker\(\)\.postMessage\(\{ type: 'init'/)
  })

  it('stop() does not idle-unload a hot engine after a meeting', () => {
    expect(finishTeardown).not.toMatch(/WORKER_IDLE_RELEASE_MS/)
  })
})

describe('MQA-285 — recap/write after stop does not block the click', () => {
  it('endReview prewarms the recap LLM in the background and does not await listen.stop', () => {
    expect(endReview).toMatch(/localPrewarm/)
    expect(endReview).not.toMatch(/await listen\.stop/)
    const prewarmAt = endReview.search(/localPrewarm/)
    const stopAt = endReview.search(/listen\.stop\(/)
    expect(prewarmAt).toBeGreaterThan(-1)
    expect(stopAt).toBeGreaterThan(-1)
    expect(prewarmAt).toBeLessThan(stopAt)
  })
})
