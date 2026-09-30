import { describe, expect, it, vi } from 'vitest'
import { parseVmStatAvailableBytes, readAvailableMemoryBytes, type MemoryReadingDeps } from './available-memory'
import { getModel, spawnProfileFor } from './local-models'
import { buildSpawnArgs } from './local-runtime'
import { LOCAL_OUTPUT_TOKEN_BUDGETS, LOCAL_CHARS_PER_TOKEN } from './local'
import { localExtractionWindowChars } from '../brain/ingest'

vi.mock('electron')

const GB = 1024 ** 3
const PAGE = 16_384
const pages = (gb: number): number => Math.round((gb * GB) / PAGE)

/** `vm_stat` on a 32 GB Apple-silicon Mac after a day of use: almost nothing "free", most of the RAM held
 *  as reclaimable inactive/speculative/purgeable cache. Shape copied from the real tool; counts synthetic. */
function vmStat(freeGB: number, inactiveGB: number, speculativeGB: number, purgeableGB: number): string {
  return [
    `Mach Virtual Memory Statistics: (page size of ${PAGE} bytes)`,
    `Pages free:                               ${pages(freeGB)}.`,
    `Pages active:                            ${pages(12)}.`,
    `Pages inactive:                          ${pages(inactiveGB)}.`,
    `Pages speculative:                        ${pages(speculativeGB)}.`,
    'Pages throttled:                                0.',
    `Pages wired down:                        ${pages(4)}.`,
    `Pages purgeable:                          ${pages(purgeableGB)}.`,
    '"Translation faults":                   123456789.',
    'Pages copy-on-write:                     1234567.',
    'Pages zero filled:                     987654321.',
    'Pages reactivated:                       1234567.',
    'Pages purged:                             123456.',
    'File-backed pages:                       654321.',
    'Anonymous pages:                         765432.',
    'Pages stored in compressor:              234567.',
    'Pages occupied by compressor:             98765.',
    'Decompressions:                          345678.',
    'Compressions:                            456789.',
    'Pageins:                                 567890.',
    'Pageouts:                                     0.',
    'Swapins:                                      0.',
    'Swapouts:                                     0.',
    ''
  ].join('\n')
}

const M_SERIES_32GB = vmStat(0.45, 9.5, 0.3, 0.6)
const FREEMEM_0_45GB = pages(0.45) * PAGE

function darwin(output: string): MemoryReadingDeps {
  return { platform: 'darwin', freemem: () => FREEMEM_0_45GB, vmStat: () => output }
}

describe('available memory on macOS counts reclaimable pages, not just free ones (M2-0430)', () => {
  it('sums free + inactive + speculative + purgeable pages at the reported page size', () => {
    const expected = (pages(0.45) + pages(9.5) + pages(0.3) + pages(0.6)) * PAGE
    expect(parseVmStatAvailableBytes(M_SERIES_32GB)).toBe(expected)
  })

  it('reads vm_stat on darwin instead of freemem()', () => {
    const bytes = readAvailableMemoryBytes(darwin(M_SERIES_32GB))
    expect(bytes / GB).toBeGreaterThan(10.5)
    expect(bytes).not.toBe(FREEMEM_0_45GB)
  })

  it('falls back to freemem() when vm_stat fails or its output is not recognized', () => {
    expect(readAvailableMemoryBytes({ ...darwin(''), vmStat: () => { throw new Error('ENOENT') } })).toBe(FREEMEM_0_45GB)
    expect(readAvailableMemoryBytes(darwin('Pages free: 12.'))).toBe(FREEMEM_0_45GB)
  })

  it('keeps freemem() on other platforms', () => {
    const vmStatRead = vi.fn(() => M_SERIES_32GB)
    expect(readAvailableMemoryBytes({ platform: 'win32', freemem: () => 7 * GB, vmStat: vmStatRead })).toBe(7 * GB)
    expect(vmStatRead).not.toHaveBeenCalled()
  })
})

describe('profile pin: 32 GB M-series with 0.45 GB "free" gets the Metal profile (M2-0430)', () => {
  const FOUR_B = getModel('qwen3.5-4b')
  const available = readAvailableMemoryBytes(darwin(M_SERIES_32GB)) / GB

  it('the old freemem() reading forced the CPU profile with 4,096-token slots', () => {
    const cpu = spawnProfileFor(FOUR_B, 32, FREEMEM_0_45GB / GB)
    expect(cpu.gpuLayers).toBe(0)
    expect(cpu.ctxSize / cpu.parallel).toBe(4096)
  })

  it('the available-memory reading offloads every layer to the GPU (-ngl 99) on the llama-server argv', () => {
    const metal = spawnProfileFor(FOUR_B, 32, available)
    expect(metal.gpuLayers).toBe(99)
    const args = buildSpawnArgs({ gguf: 'g', mmproj: 'm', vision: false, ...metal })
    expect(Number(args[args.indexOf('-ngl') + 1])).toBeGreaterThan(0)
    expect(args[args.indexOf('-c') + 1]).toBe(String(metal.ctxSize))
  })

  it('one slot holds a 60-minute recap and a full-size extraction window', () => {
    const metal = spawnProfileFor(FOUR_B, 32, available)
    const slotTokens = metal.ctxSize / metal.parallel
    // A 60-minute meeting is ~9,000 spoken words: about 55,000 transcript characters with speaker labels.
    const recapPromptChars = 55_000 + 6_000 // transcript plus the summary system prompt and framing
    const recapTokens = Math.ceil(recapPromptChars / LOCAL_CHARS_PER_TOKEN) + LOCAL_OUTPUT_TOKEN_BUDGETS.summary
    expect(recapTokens).toBeLessThanOrEqual(slotTokens)
    expect(localExtractionWindowChars(slotTokens)).toBe(24_000)
  })

  it('a squeezed 32 GB Mac (under 5 GB available) still falls to the CPU profile', () => {
    const squeezed = readAvailableMemoryBytes(darwin(vmStat(0.2, 3, 0.1, 0.2))) / GB
    expect(spawnProfileFor(FOUR_B, 32, squeezed).gpuLayers).toBe(0)
  })
})
