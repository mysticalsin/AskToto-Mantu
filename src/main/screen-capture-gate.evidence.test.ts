import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createScreenPreprocess, type ScreenPreprocessDeps } from './screen-preprocess'
import type { ForegroundInfo, ForegroundWatcher } from './foreground-watcher'

describe('capture-gate CI evidence', () => {
  it('measures that a denied Windows gate keeps the background loop from taking shots', async () => {
    let shots = 0
    let currentWin: ForegroundInfo | null = { windowId: 'w1', pid: 1, title: 'window' }
    const auditEvents: Array<{ event: string; data?: Record<string, unknown> }> = []
    const deps: ScreenPreprocessDeps = {
      getScreenshot: async () => {
        shots++
        throw new Error('Windows capture denied')
      },
      getSettings: () => ({
        backgroundScreenContext: true,
        localLlm: { enabled: true, modelId: 'qwen3.5-0.8b' }
      }),
      localReady: () => true,
      authorized: () => true,
      currentDisplayId: () => 1,
      privateViewOn: () => false,
      ensureLocalRuntimeStarted: async () => {},
      runtime: {
        baseURL: () => 'http://127.0.0.1:9999/v1',
        sessionKey: () => 'test',
        markActivity: () => {},
        beginStream: () => {},
        endStream: () => {},
        activeStreams: () => 0
      },
      startWatcher: (onChange) => {
        const watcher: ForegroundWatcher = {
          stop: () => {},
          current: () => currentWin,
          healthy: () => true
        }
        onChange(currentWin!)
        return watcher
      },
      screenCaptureGranted: () => false,
      platform: 'win32',
      now: () => 1_000_000,
      log: () => {},
      audit: (event, data) => auditEvents.push({ event, data })
    }

    const sp = createScreenPreprocess(deps)
    sp.refresh()
    for (let i = 0; i < 20; i++) {
      await sp._test.describeForWindow('w1')
    }

    const captureFailedEvents = auditEvents.filter((entry) => entry.event === 'capture.failed')
    const evidence = {
      suite: 'capture-gate',
      platform: 'windows-latest',
      deniedBackgroundShots: shots,
      captureFailedEvents: captureFailedEvents.length,
      repeatingCaptureFailedEvents: Math.max(0, captureFailedEvents.length - 1),
      backgroundActive: sp.isActive(),
      canRun: sp.canRun()
    }

    const out = process.env.CAPTURE_GATE_EVIDENCE
    if (out) {
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`)
    }

    expect(evidence.deniedBackgroundShots).toBe(0)
    expect(evidence.repeatingCaptureFailedEvents).toBe(0)
    expect(evidence.backgroundActive).toBe(false)
    expect(evidence.canRun).toBe(false)
    currentWin = null
    sp.stop()
  })
})
