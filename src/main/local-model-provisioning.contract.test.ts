/**
 * local-model-provisioning.contract.test.ts — MQA-186.
 *
 * The Métis Local weights are not in the installer; `ensureLocalModel` fetches them when the app opens.
 * Boot gates that fetch on RAM (never fetch onto a machine that cannot load the model). Local AI
 * `enabled` controls routing only — not whether bytes are fetched — so turning Local on later is
 * instant once the background download has finished.
 *
 * Source-contract, following App.local-gates.test.ts / screen-preprocess-wiring.contract.test.ts: there
 * is no harness that boots main/index.ts, but the wiring is structural and can be asserted directly. The
 * behaviour of the gate itself (RAM floor, progress) is unit-tested for real in
 * llm/local-model-download.test.ts.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const src = readFileSync(join(__dirname, 'index.ts'), 'utf8').replace(/\r\n/g, '\n')

function sliceBetween(text: string, start: string, end: string): string {
  const a = text.indexOf(start)
  if (a === -1) throw new Error(`anchor not found (source moved?): ${start}`)
  const b = text.indexOf(end, a)
  if (b === -1) throw new Error(`end marker not found after anchor: ${end}`)
  return text.slice(a, b)
}

describe('MQA-186 — the first-run weight fetch is gated, and the gate is not a dead end', () => {
  it('boot asks whether this machine should fetch the weights before starting a multi-GB transfer', () => {
    const boot = sliceBetween(src, 'app.whenReady().then(async () => {', 'app.setAppUserModelId')
    // RAM floor only — Local AI enabled does not gate the download (routing stays off by default).
    // The model is chosen by HARDWARE (bestModelForMachine), not by registry position — indexing
    // LOCAL_MODELS[0] would silently fetch whichever entry happened to be listed first.
    expect(boot).toMatch(/const best = bestModelForMachine\(\)/)
    expect(boot).toMatch(/shouldFetchWeights\(best\.id\)/)
    expect(boot).not.toMatch(/shouldFetchWeights\(best\.id, getSettings\(\)\.localLlm\.enabled\)/)
    // ...and the call it guards is the one that costs the bytes.
    expect(boot).toMatch(/ensureLocalModel\(best\.id\)/)
  })

  it('turning Local AI on still re-arms the fetch as a second chance after a failed boot download', () => {
    // Boot starts the download on open; OFF→ON re-arms if the first attempt failed (offline, disk, etc.).
    const handler = sliceBetween(src, 'const next = setSettings(p)', 'ipcMain.handle(IPC.settingsRecoverProfile')
    expect(handler).toMatch(/!cur\.localLlm\.enabled && next\.localLlm\.enabled/)
    expect(handler).toMatch(/ensureLocalModel\(next\.localLlm\.modelId\)/)
    // Same MQA-178 reason as boot: the background screen reader's eligibility is only re-evaluated on a
    // refresh, and this download lands long after the settings save returns.
    expect(handler).toMatch(/refreshScreenPreprocess\(\)/)
  })

  it('the readiness IPC carries the download state, so the renderer can tell the cases apart', () => {
    const handler = sliceBetween(src, 'ipcMain.handle(IPC.localModelsList', '})')
    expect(handler).toMatch(/listLocalModels\(localModelDownloadState\(\)\)/)
  })
})

describe('MQA-191 — main never offers reinstall as the remedy for weights the installer does not carry', () => {
  it('the screenshot failure message points at a place that can actually answer', () => {
    // scripts/check-packaged-runtime.mjs FAILS THE BUILD if a .gguf reappears under resources/local-llm,
    // so "reinstall Métis" was guaranteed by CI to change nothing.
    const vision = sliceBetween(src, 'Métis Local could not process this screenshot', "'")
    expect(vision).not.toMatch(/reinstall/i)
    expect(vision).toMatch(/Local AI/)
  })

  it('no user-facing string in main blames a missing bundled model', () => {
    expect(src).not.toMatch(/reinstall it if the bundled model is missing/i)
  })
})
