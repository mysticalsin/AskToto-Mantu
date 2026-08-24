import { describe, expect, it } from 'vitest'
import { LOCAL_MODELS, getModel, spawnProfileFor, GPU_OFFLOAD_MIN_RAM_GB } from './local-models'
import { buildSpawnArgs } from './local-runtime'

const FOUR_B = getModel('qwen3.5-4b')

/**
 * Measured on the packaged build with the 4B, committed private bytes (the figure that competes for RAM
 * on a small machine — mmapped weights are reclaimable page cache and are NOT what pushed it over):
 *   -ngl 99, ctx 16384, parallel 2  ->  5611 MB
 *   -ngl 0,  ctx 8192,  parallel 2  ->  2811 MB
 *   -ngl 0,  ctx 4096,  parallel 1  ->  1946 MB
 * The dominant term is -ngl, not the context window.
 */
describe('spawnProfileFor — the sidecar must fit the machine it is on', () => {
  it('refuses GPU offload on an 8 GB machine, which is what put it over budget', () => {
    const p = spawnProfileFor(FOUR_B, 8)
    expect(p.gpuLayers).toBe(0)
    // ~2811 MB measured at this shape, leaving roughly 5 GB of an 8 GB machine for the OS and the app.
    expect(p.ctxSize).toBeLessThanOrEqual(8192)
    expect(p.parallel).toBe(2) // a second concurrent ask must still have a slot
  })

  it('keeps the faster offloaded configuration once there is headroom', () => {
    const p = spawnProfileFor(FOUR_B, 32)
    expect(p.gpuLayers).toBe(99)
    expect(p.ctxSize).toBe(FOUR_B.ctxSize)
  })

  it('switches exactly at the documented threshold, not somewhere near it', () => {
    expect(spawnProfileFor(FOUR_B, GPU_OFFLOAD_MIN_RAM_GB - 0.1).gpuLayers).toBe(0)
    expect(spawnProfileFor(FOUR_B, GPU_OFFLOAD_MIN_RAM_GB).gpuLayers).toBe(99)
  })

  it('never hands back a context larger than the model asked for', () => {
    for (const m of LOCAL_MODELS) {
      for (const ram of [4, 8, 12, 16, 64]) {
        expect(spawnProfileFor(m, ram).ctxSize).toBeLessThanOrEqual(m.ctxSize)
        expect(spawnProfileFor(m, ram).ctxSize).toBeGreaterThan(0)
      }
    }
  })

  it('the profile actually reaches the sidecar argv', () => {
    // A profile that is computed but not passed through would be a silent no-op — the whole point is the
    // flags llama-server receives.
    const small = spawnProfileFor(FOUR_B, 8)
    const args = buildSpawnArgs({ gguf: 'g', mmproj: 'm', ...small })
    expect(args[args.indexOf('-ngl') + 1]).toBe('0')
    expect(args[args.indexOf('-c') + 1]).toBe(String(small.ctxSize))
    expect(args[args.indexOf('--parallel') + 1]).toBe(String(small.parallel))

    const big = spawnProfileFor(FOUR_B, 64)
    const bigArgs = buildSpawnArgs({ gguf: 'g', mmproj: 'm', ...big })
    expect(bigArgs[bigArgs.indexOf('-ngl') + 1]).toBe('99')
  })
})
