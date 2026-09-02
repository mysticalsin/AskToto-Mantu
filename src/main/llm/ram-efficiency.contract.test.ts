import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSpawnArgs, inferenceThreads } from './local-runtime'
import { GPU_OFFLOAD_MIN_FREE_RAM_GB, spawnProfileFor, LOCAL_MODELS } from './local-models'

const RUNTIME = readFileSync(join(__dirname, 'local-runtime.ts'), 'utf8')
const LISTEN = readFileSync(join(__dirname, '..', '..', 'renderer', 'src', 'lib', 'listen.ts'), 'utf8')
const TOAST = readFileSync(join(__dirname, '..', '..', 'renderer', 'src', 'components', 'UpdateReadyToast.tsx'), 'utf8')
const CODEBLOCK = readFileSync(join(__dirname, '..', '..', 'renderer', 'src', 'components', 'CodeBlock.tsx'), 'utf8')
const BUILDER = readFileSync(join(__dirname, '..', '..', '..', 'electron-builder.yml'), 'utf8')

const BASE = { gguf: 'm.gguf', vision: false, mmproj: 'p.gguf', ctxSize: 8192, parallel: 2, gpuLayers: 0 }

/**
 * MQA-270 — RAM and latency on machines that do not have much of either.
 *
 * The report was "Metis lags on devices without a lot of RAM". The audit found the lag was mostly
 * self-inflicted: a 1.03 GB multimodal projector loaded at startup for sessions that never see an image,
 * llama-server claiming every physical core (starving the renderer and the ASR worker it shares the
 * machine with), speculative model warms that consulted totalmem() but never freemem(), a 592 kB markdown
 * subgraph in the overlay's boot chunk for a toast body, and a dead 20.6 MB wasm double-shipped in the
 * asar. Every change here is from the measured plan's "free wins" group — zero answer-quality cost.
 */
describe('MQA-270 (B1) — the projector loads only when vision is live', () => {
  it('spawns with --no-mmproj for a text-only runtime, --mmproj for vision', () => {
    const text = buildSpawnArgs({ ...BASE, vision: false })
    expect(text).toContain('--no-mmproj')
    expect(text).not.toContain('--mmproj')
    const vis = buildSpawnArgs({ ...BASE, vision: true })
    expect(vis).toContain('--mmproj')
    expect(vis).toContain('p.gguf')
    expect(vis).not.toContain('--no-mmproj')
  })

  it('vision is one-way sticky in samePaths — upgrade restarts, downgrade never does', () => {
    // Asymmetric on purpose: a projector-holding runtime satisfies a text request (superset), but a
    // text-only runtime must NOT satisfy a vision request. Symmetric comparison would thrash a 14.6s
    // reload on every text/vision alternation; ignoring vision (the old code) would never restart at
    // all and the first screen ask would hit a server with no projector.
    expect(RUNTIME).toMatch(/a\.vision \|\| !b\.vision/)
  })
})

describe('MQA-270 (B5) — llama-server no longer claims every core', () => {
  it('derives threads from estimated physical cores, minus headroom, floored at 2', () => {
    expect(inferenceThreads(16)).toBe(6) // 8 physical - 2
    expect(inferenceThreads(8)).toBe(2) // 4 physical - 2
    expect(inferenceThreads(4)).toBe(2) // floor: a 2-core machine still generates
    expect(inferenceThreads(2)).toBe(2)
  })

  it('passes -t, -tb and --threads-http', () => {
    const args = buildSpawnArgs({ ...BASE, vision: false })
    expect(args).toContain('-t')
    expect(args).toContain('-tb')
    expect(args).toContain('--threads-http')
  })
})

describe('MQA-270 (B9) — full GPU offload requires FREE ram, not just total', () => {
  it('a big machine that is currently squeezed falls to the CPU profile', () => {
    const entry = LOCAL_MODELS[0]
    const squeezed = spawnProfileFor(entry, 16, GPU_OFFLOAD_MIN_FREE_RAM_GB - 1)
    expect(squeezed.gpuLayers).toBe(0)
    const roomy = spawnProfileFor(entry, 16, GPU_OFFLOAD_MIN_FREE_RAM_GB)
    expect(roomy.gpuLayers).toBe(99)
  })
})

describe('MQA-270 (B7) — the whisper prewarm is engine-gated (MQA-285 keeps a hot engine)', () => {
  it('skips the ~100 MB whisper warm when the configured engine is apple', () => {
    expect(LISTEN).toMatch(/if \(asrEngine === 'apple'\) return/)
  })

  it('does not idle-unload a prewarmed engine (MQA-285)', () => {
    // B7 originally armed WORKER_IDLE_RELEASE_MS after prewarm. That made first Listen (and recap)
    // a cold start if the user waited ~3 min — the opposite of click-to-transcript. Unmount still
    // tears the worker down; prewarm/stop must not.
    const at = LISTEN.indexOf("if (asrEngine === 'apple') return")
    const block = LISTEN.slice(at, at + 1600)
    expect(block).not.toMatch(/WORKER_IDLE_RELEASE_MS/)
    expect(block).not.toMatch(/workerRef\.current\?\.terminate\(\)/)
  })
})

describe('MQA-270 (B2/B3) — markdown stays out of the boot chunk', () => {
  it('UpdateReadyToast imports Markdown lazily behind Suspense', () => {
    expect(TOAST).toMatch(/lazy\(\(\) => import\('\.\/Markdown'\)/)
    expect(TOAST).toMatch(/<Suspense fallback=\{null\}>/)
    expect(TOAST).not.toMatch(/^import \{ Markdown \}/m)
  })

  it('the shiki warm is no longer a module-scope side effect', () => {
    // As a bare side effect it ran at module load — i.e. boot, once anything static imported the chain —
    // pinning 1.74 MB of wasm + grammars forever via the hlPromise singleton.
    expect(CODEBLOCK).toMatch(/export function warmHighlighter/)
    expect(CODEBLOCK).not.toMatch(/^if \(typeof window !== 'undefined'\) \{/m)
  })
})

describe('MQA-270 (B6) — the dead ORT wasm copy stays out of the asar', () => {
  it('excludes the Vite-emitted duplicate, never the live resources/ort copy', () => {
    expect(BUILDER).toMatch(/!out\/renderer\/assets\/ort-wasm-\*\.wasm/)
    // resources/ort is the copy asr-model://ort/ actually serves — check-packaged-runtime pins it.
    expect(BUILDER).not.toMatch(/!resources\/ort/)
  })
})
