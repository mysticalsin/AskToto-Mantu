/**
 * qa-hooks.ts — the QA-only boot hooks index.ts imports in one place.
 *
 * Importing this module arms the packaged HK-M proof (see qa-hk-m.ts): once the first window finishes loading,
 * the row named by METIS_HK_M_SCENARIO starts, once per boot. It is inert unless the app is packaged, runs on an
 * isolated ASKTOTO_USERDATA profile and the env names a known row, and it writes only content-free markers the
 * harness reads before it SIGKILLs main.
 */
import { join } from 'node:path'
import { app } from 'electron'
import { auditLog, mainLog } from './logger'
import { bundledFfmpegPath, startFfmpegDecode } from './ffmpeg-decoder'
import { ensureLocalRuntimeStarted } from './llm/local'
import * as localRuntime from './llm/local-runtime'
import { recordSidecarIntent } from './infra/process/registry'
import { armQaHostFloorOverride, hkMScenarioFromEnv, hkMSetupFailedDetail, productionHkMDeps, runHkMScenario } from './qa-hk-m'

export { QA_IDENTITY_BUILD, installQaFaultHook } from './qa-identity'

// M2-0482: the QA RAM-floor override is decided once, at import, before index.ts consults any floor. It reads the
// launch env, not app.getPath('userData'), so it does not depend on index.ts's later setPath. Electron's default
// userData is appData/<app name>; the gate stays off unless the packaged app runs on a different, isolated profile.
armQaHostFloorOverride(process.env, app.isPackaged, join(app.getPath('appData'), app.getName()))

const hkMScenario = hkMScenarioFromEnv(process.env, app.isPackaged)
if (hkMScenario) {
  let started = false
  app.on('web-contents-created', (_event, contents) => {
    contents.once('did-finish-load', () => {
      if (started) return
      started = true
      void runHkMScenario(
        hkMScenario,
        productionHkMDeps(
          { ensureLocalRuntimeStarted, localRuntime, bundledFfmpegPath, startFfmpegDecode, recordSidecarIntent },
          (event) => auditLog(event),
          (row, error) => {
            // The harness deletes the throwaway profile, so the audit marker is what carries the cause out.
            auditLog('hk-m.setup-failed', hkMSetupFailedDetail(row, error))
            mainLog.warn(`[hk-m] ${row} setup failed`, error instanceof Error ? error.message : String(error))
          },
          app.getPath('userData'),
          process.resourcesPath
        )
      )
    })
  })
}
