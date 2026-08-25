import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SUITE = readFileSync(join(__dirname, 'e2e-workflows.mjs'), 'utf8')

/**
 * MQA-255 — the physical QA suite has to measure the APP, not the machine it ran on.
 *
 * It reported 10 failures against a healthy build. Every one traced to something other than the product:
 *
 *   5  the on-device weights were still downloading on a fresh profile, so every "answers on-device"
 *      check fell through to a cloud provider — the app behaving exactly as designed;
 *   1  the operator launched with ASKTOTO_DISABLE_CP=1, which turns content protection off, and the
 *      suite duly reported that Private View did not block capture;
 *   3  leftover state from the suite's OWN previous run: groups restore what they mutate on the happy
 *      path, but a group that FAILS never reaches its restore, so run two inherited run one's residue;
 *   3  provider keys exported in the shell environment. store.ts's getApiKey reads
 *      process.env[ENV_VAR[provider]] BEFORE the profile store, so "zero API keys configured" cannot be
 *      arranged on such a machine at all — no isolated profile can remove them.
 *
 * A red line that is not a defect is worse than no line: it is what teaches people that red lines do not
 * mean anything. So the suite now separates "the app is broken" from "this environment cannot test that",
 * and says which blocker applies. These are pinned because both halves rot silently — a restore that
 * stops running, or a genuine failure quietly downgraded to a note.
 */
describe('MQA-255 — the QA suite reports the build, not the environment', () => {
  it('snapshots the settings it mutates and restores them afterwards', () => {
    // Without this, running the suite twice against one profile produces different answers — which means
    // at least one of those answers is wrong about the app.
    expect(SUITE).toMatch(/const SETTINGS_SNAPSHOT = await/)
    expect(SUITE).toMatch(/async function restoreSettingsSnapshot\(\)/)
    expect(SUITE).toMatch(/await restoreSettingsSnapshot\(\)/)
    // Restore must run after the groups and before the summary is computed, so a failing group cannot
    // skip it the way per-group restores were skipped.
    const restoreAt = SUITE.indexOf('await restoreSettingsSnapshot()')
    const summaryAt = SUITE.indexOf("const passed = results.filter((r) => r.status === 'pass').length")
    expect(restoreAt).toBeGreaterThan(-1)
    expect(summaryAt).toBeGreaterThan(restoreAt)
  })

  it('lets a check downgrade ITSELF to "not exercised" rather than failing', () => {
    expect(SUITE).toMatch(/typeof detail\.__info === 'string'/)
    expect(SUITE).toMatch(/record\(group, name, 'info', detail\.__info\)/)
  })

  it('never folds a not-exercised check into the passed count', () => {
    // The whole point of the third state: a check that did not run must not read as one that succeeded.
    expect(SUITE).toMatch(/const skipped = results\.filter\(\(r\) => r\.status === 'info'\)\.length/)
    expect(SUITE).toMatch(/const passed = results\.filter\(\(r\) => r\.status === 'pass'\)\.length/)
  })

  it('names the specific blocker, never a bare "skipped"', () => {
    // "not exercised" with no reason is just a failure nobody will investigate.
    for (const blocker of [
      /weights are still arriving/,
      /_API_KEY/,
      /working \$\{r\.providers\.at\(-1\)\} key/
    ]) {
      expect(SUITE).toMatch(blocker)
    }
  })

  it('still FAILS hard when the model is present, not downloading, and not ready', () => {
    // The line between environment and defect. Weights on disk that will not load is a real bug — a bad
    // RAM floor, a damaged file — and must not be absorbed by the same excuse as a cold profile.
    expect(SUITE).toMatch(/no ready model and none downloading/)
  })
})
