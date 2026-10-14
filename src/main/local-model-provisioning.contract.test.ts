/**
 * local-model-provisioning.contract.test.ts — MQA-186.
 *
 * Optional weights are fetched only after an explicit Download/Retry request. Local AI opt-in and
 * startup are readiness-only; package/runtime and managed policy gates still precede any transfer.
 *
 * Source-contract, following App.local-gates.test.ts / screen-preprocess-wiring.contract.test.ts: there
 * is no harness that boots main/index.ts, but the wiring is structural and can be asserted directly. The
 * behaviour of the gate itself (RAM floor, progress) is unit-tested for real in
 * llm/local-model-download.test.ts.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { sourceIndexOf } from '../../scripts/lib/source-layout'

const src = readFileSync(join(__dirname, 'index.ts'), 'utf8').replace(/\r\n/g, '\n')

function sliceBetween(text: string, start: string, end: string): string {
  const a = sourceIndexOf(text, start)
  if (a === -1) throw new Error(`anchor not found (source moved?): ${start}`)
  const b = sourceIndexOf(text, end, a + 1)
  if (b === -1) throw new Error(`end marker not found after anchor: ${end}`)
  return text.slice(a, b)
}

describe('MQA-186 — optional weights require an explicit request', () => {
  it('boot never provisions weights or upgrades the selected model', () => {
    const boot = sliceBetween(src, 'app.whenReady().then(async () => {', 'app.setAppUserModelId')
    expect(boot).not.toMatch(/provisionLocalModel|ensureLocalModel\(/)
    expect(boot).not.toMatch(/bestModelForMachine|setSettings\(\{ localLlm/)
    expect(boot).toContain('localModelDownloaded(cur.localLlm.modelId)')
  })

  it('the explicit request is package and policy gated before provisioning', () => {
    expect(src).toMatch(/ipcMain\.handle\(IPC\.localModelsEnsure/)
    const handler = sliceBetween(src, 'ipcMain.handle(IPC.localModelsEnsure', '// MQA-247')
    expect(handler).toMatch(/contract\.profile === 'lean'/)
    expect(handler).toMatch(/getPublishedSettingsObservation\(\)\?\.readable !== true/)
    expect(handler).toMatch(/provisionLocalModel\(admittedModel, allowed, ensureLocalModel, 'explicit'\)/)
  })

  it('changing Local AI settings never starts a download', () => {
    const handler = sliceBetween(
      src,
      'const next = setSettingsWithSpeakerPolicy(p)',
      'ipcMain.handle(IPC.settingsRecoverProfile'
    )
    expect(handler).not.toMatch(/provisionLocalModel|ensureLocalModel\(/)
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
