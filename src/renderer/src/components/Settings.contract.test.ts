/**
 * Settings.contract.test.ts — source-contract test for five renderer-only bugs fixed in Settings.tsx
 * (fix batch B_Settings). There is no component-render harness for Settings.tsx anywhere in this repo
 * (it's a large, deeply-nested Electron settings panel wired to window.toto IPC stubs), so — following
 * App.local-gates.test.ts / local-prewarm.test.ts's "structural proof" pattern (readFileSync + regex over
 * the real source) — this pins the shape of each fix so a future edit can't silently regress it.
 *
 * Anchors are function/branch names, never line numbers, so reordering unrelated code doesn't break this.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const source = readFileSync(join(__dirname, 'Settings.tsx'), 'utf8')

// Returns the source slice from `startAnchor` up to (not including) the first `endMarker` found after it.
function blockAfter(startAnchor: string, endMarker: string): string {
  const start = source.indexOf(startAnchor)
  if (start === -1) throw new Error(`Settings.contract.test.ts anchor not found (source moved?): ${startAnchor}`)
  const end = source.indexOf(endMarker, start)
  if (end === -1) throw new Error(`Settings.contract.test.ts end marker not found after anchor: ${endMarker}`)
  return source.slice(start, end)
}

describe('onDelete surfaces a failed local-model delete inline (finding 1)', () => {
  const block = blockAfter('const onDelete = (id: string)', '\n\n  const primaryBtn')

  it('branches on r.ok, not just calling loadModels() unconditionally', () => {
    expect(block).toMatch(/if\s*\(r\.ok\)\s*loadModels\(\)/)
  })

  it('the failure branch writes into downloadState — the same state the download-error row reads', () => {
    expect(block).toMatch(/else\s+setDownloadState\(/)
    expect(block).toMatch(/phase:\s*'error'/)
  })
})

describe("runtime status line no longer overclaims after 'unavailable' (finding 2)", () => {
  const block = blockAfter('settings.localRuntimeRunning', '</div>')

  it('the not-running branch no longer promises an unconditional automatic restart', () => {
    // The old copy asserted "starts automatically" as fact with no hedge or recovery path — that stayed
    // reassuring even once local-runtime.ts's restart budget was exhausted for the rest of the session.
    expect(block).not.toMatch(/starts automatically on the first live suggestion/)
  })

  it('names the actual recovery path (restarting the app) since localRuntimeRunning cannot ' +
      "distinguish idle-stopped from permanently-'unavailable'", () => {
    expect(block).toMatch(/restart Métis/)
  })
})

describe('connectCli() branches on accessDenied instead of misdirecting into reinstall/re-login (finding 3)', () => {
  const block = blockAfter('const connectCli = async ()', '\n  // Save a Dust API key')

  it('checks r.accessDenied before falling through to the setup/reinstall path', () => {
    const deniedIdx = block.indexOf('r.accessDenied')
    const setupIdx = block.indexOf('No Dust CLI found. Starting setup')
    expect(deniedIdx).toBeGreaterThan(-1)
    expect(setupIdx).toBeGreaterThan(-1)
    expect(deniedIdx).toBeLessThan(setupIdx)
  })

  it('the accessDenied branch returns before reaching dustSetupCli() (no reinstall/re-login)', () => {
    const deniedIdx = block.indexOf('if (r.accessDenied)')
    const nextReturn = block.indexOf('return', deniedIdx)
    const setupCall = block.indexOf('dustSetupCli()', deniedIdx)
    expect(nextReturn).toBeGreaterThan(-1)
    expect(nextReturn).toBeLessThan(setupCall)
  })
})

describe('disconnectDust() clears dustTokenMintedAt (finding 4)', () => {
  const block = blockAfter('const disconnectDust = async ()', '\n  // Remove just the saved Dust API key')

  it('resets dustTokenMintedAt to 0 in the same patch as the rest of the disconnect reset', () => {
    expect(block).toMatch(/dustTokenMintedAt:\s*0/)
  })
})

describe('the Custom provider tile can actually be selected (finding 5)', () => {
  const block = blockAfter('{shown.map((id) => (', '))}\n          </div>')

  it("seeds a valid https:// customBaseUrl alongside provider:'custom' so SettingsSchema's refine " +
      '(provider !== \'custom\' || /^https:\\/\\//i.test(customBaseUrl)) does not revert the write', () => {
    expect(block).toMatch(/id === 'custom'/)
    expect(block).toMatch(/customBaseUrl:\s*'https:\/\//)
  })

  it('does not touch customBaseUrl when one is already a valid https:// URL (no clobbering a real endpoint)', () => {
    expect(block).toMatch(/!\/\^https:\\\/\\\/\/i\.test\(settings\.customBaseUrl\)/)
  })
})
