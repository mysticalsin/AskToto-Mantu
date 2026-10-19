/**
 * MQA-285 — Listen click-to-transcript must be immediate.
 *
 * Capture waits for Main's meeting admission, then proceeds independently of model readiness.
 * Concrete Whisper choices prewarm at app-ready and stay hot; recap does not await Stop drain.
 *
 * These source checks complement the pending/denied/stale-admission behavior cases in
 * listen.stop-drain.test.ts, which run the real hook against fake browser/audio boundaries.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sourceIndexOf } from '../../../../scripts/lib/source-layout'

const SRC = readFileSync(join(__dirname, 'listen.ts'), 'utf8').replace(/\r\n/g, '\n')
const APP = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8').replace(/\r\n/g, '\n')

function blockBetween(src: string, from: string, to: string): string {
  const start = sourceIndexOf(src, from)
  expect(start, `marker not found: ${from}`).toBeGreaterThan(-1)
  const end = sourceIndexOf(src, to, start + 1)
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
const prewarm = codeOnly(
  blockBetween(SRC, '// MQA-285: once Settings has resolved', '// Mid-session spoken-language change')
)
const finishTeardown = codeOnly(
  blockBetween(SRC, 'const finishTeardown = (): void => {', 'const waitForDrain = (): void => {')
)
const endReview = codeOnly(blockBetween(APP, 'const endReview = useCallback(', 'const toggleListen = useCallback('))

describe('MQA-285 — admitted capture proceeds without waiting for ASR readiness', () => {
  it('awaits Main admission before either microphone acquisition or loopback arming', () => {
    const admission = startBody.search(/await window\.toto\.setListeningState\(true, startedAt\)/)
    const micKick = startBody.search(/acquireMic\(/)
    const systemArm = startBody.search(/await window\.toto\.armAudio\(true\)/)
    expect(admission).toBeGreaterThan(-1)
    expect(micKick).toBeGreaterThan(-1)
    expect(systemArm).toBeGreaterThan(-1)
    expect(admission).toBeLessThan(micKick)
    expect(admission).toBeLessThan(systemArm)
  })

  it('does not await parakeetStatus, parakeetEnsure, or getAsrBundled before kicking the admitted mic', () => {
    const micKick = startBody.search(/acquireMic\(/)
    expect(micKick).toBeGreaterThan(-1)
    const beforeMic = startBody.slice(0, micKick)
    expect(beforeMic).not.toMatch(/await window\.toto\.parakeetStatus/)
    expect(beforeMic).not.toMatch(/await window\.toto\.parakeetEnsure/)
    expect(beforeMic).not.toMatch(/await getAsrBundled/)
  })

  it('keeps pumping queued windows once ASR reports ready so the first second is not dropped', () => {
    expect(SRC).toMatch(/pump\(\) \/\/ drain windows captured while the model loaded/)
    expect(startBody).toMatch(/if \(readyRef\.current\) pump\(\)/)
  })
})

describe('MQA-285 — prewarm concrete Whisper at app ready, keep that engine hot', () => {
  it('prewarms immediately, not after a 4s delay or requestIdleCallback', () => {
    expect(prewarm).not.toMatch(/setTimeout\([^,]+,\s*4000\)/)
    expect(prewarm).not.toMatch(/requestIdleCallback/)
    expect(prewarm).toMatch(/void warm\(\)/)
  })

  it('does not idle-unload the prewarmed worker', () => {
    expect(prewarm).not.toMatch(/WORKER_IDLE_RELEASE_MS/)
    expect(prewarm).not.toMatch(/workerRef\.current\?\.terminate\(\)/)
  })

  it('waits for a concrete Whisper choice instead of warming unknown or Parakeet', () => {
    expect(prewarm).toMatch(/asrEngine !== 'whisper'/)
    expect(prewarm).not.toMatch(/parakeetEnsure/)
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

describe('enterprise-live CLOUD_ONLY — local ASR start gate', () => {
  it('asserts cloud-only before local whisper/parakeet/apple start and surfaces CLOUD_ONLY_LOCAL_FALLBACK_BLOCKED', () => {
    expect(startBody).toMatch(/assertCloudOnlyAllowsEngine/)
    expect(startBody).toMatch(/CLOUD_ONLY_LOCAL_FALLBACK_BLOCKED/)
    const assertAt = startBody.search(/assertCloudOnlyAllowsEngine/)
    const parakeetAt = startBody.search(/engine === 'parakeet'/)
    const whisperAt = startBody.search(/engineRef\.current === 'whisper'/)
    expect(assertAt).toBeGreaterThan(-1)
    expect(parakeetAt).toBeGreaterThan(-1)
    expect(assertAt).toBeLessThan(parakeetAt)
    if (whisperAt > -1) expect(assertAt).toBeLessThan(whisperAt)
  })

  it('blocks silent Parakeet→Whisper fallback under CLOUD_ONLY', () => {
    const fb = codeOnly(blockBetween(SRC, 'const fallBackToWhisper = useCallback', 'const networkRetryCleanupRef'))
    expect(fb).toMatch(/assertCloudOnlyAllowsEngine/)
    expect(fb).toMatch(/CLOUD_ONLY_LOCAL_FALLBACK_BLOCKED/)
  })
})

describe('enterprise-live cloud STT language (FR Listen)', () => {
  it('wires Settings asrLanguage into Nova/Soniox resolvers at start and setLanguage', () => {
    expect(SRC).toMatch(/resolveNova3LanguageQuery/)
    expect(SRC).toMatch(/resolveSonioxLanguageConfig/)
    expect(SRC).toMatch(/cloudSttLanguageForListen/)
    expect(startBody).toMatch(/resolveNova3LanguageQuery\(language\)/)
    expect(startBody).toMatch(/resolveSonioxLanguageConfig\(language\)/)
  })

  it('does not hardcode English-only for cloud STT language', () => {
    expect(SRC).toMatch(/export function cloudSttLanguageForListen/)
  })
})

describe('enterprise-live cloud engine path', () => {
  it('starts a cloud engine branch without booting Whisper/Parakeet', () => {
    expect(startBody).toMatch(/if \(engine === 'cloud'\)/)
    expect(startBody).toMatch(/cloud STT session planned/)
    expect(startBody).toMatch(/shouldUseCloudSttEngine/)
    expect(APP).toMatch(/resolveListenEngine\(settings\)/)
    expect(APP).toMatch(/listen\.start\([\s\S]{0,180}engine/)
  })

  it('attaches live cloud WS (cloudSttStart) and streams PCM (cloudSttPush)', () => {
    expect(startBody).toMatch(/cloudSttStart/)
    expect(SRC).toMatch(/cloudSttPush/)
    expect(SRC).toMatch(/cloudSttStop/)
    expect(startBody).toMatch(/onCloudSttFinal/)
  })
})
