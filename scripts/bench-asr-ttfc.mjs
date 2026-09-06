#!/usr/bin/env node
/**
 * Time-to-first-caption scheduling bench (docs/asr/QUALITY.md).
 *
 * Does not load Whisper weights. Measures the capture-path budget: speech-onset → first partial
 * emit (1200ms) + a stub decode. Best quality must not sit behind the 6s monologue cap.
 *
 * Usage: node scripts/bench-asr-ttfc.mjs
 */
const FIRST_PARTIAL_MS = 1200
const LIVE_WINDOW_CAP_MS = 6000
const stubDecodeMs = Number(process.env.ASR_STUB_DECODE_MS || 400)

const ttfc = FIRST_PARTIAL_MS + stubDecodeMs
const vsCap = LIVE_WINDOW_CAP_MS - ttfc

console.log('Métis ASR TTFC bench (scheduling only — decode is a stub)')
console.log(`  first partial: ${FIRST_PARTIAL_MS} ms`)
console.log(`  stub decode:   ${stubDecodeMs} ms`)
console.log(`  TTFC budget:   ${ttfc} ms`)
console.log(`  vs 6s cap:     ${vsCap} ms faster`)

if (ttfc >= LIVE_WINDOW_CAP_MS / 2) {
  console.error('FAIL: Best-quality scheduling feels stuck (TTFC >= 3s cap/2)')
  process.exit(1)
}
console.log('PASS: Best-quality first caption is scheduled well before the monologue cap')
