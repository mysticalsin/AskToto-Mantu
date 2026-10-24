// G88: the one table of scenario id -> ordered step ids. `--dry-run`, the capability map checker and the E2E report all read it,
// so a step id exists in exactly one place and the map cannot name a step that no scenario records.
import { MEMORY_ASSISTANTS_STEPS } from './memory-assistants.mjs'
import { QUIET_MODE_STEPS } from './quiet-mode.mjs'
import { SETTINGS_HIG_STEPS } from './settings-hig.mjs'
import { STRESS_CASES, stressSteps } from './stress-lib.mjs'
import { UPGRADE_STEPS } from './upgrade.mjs'
import { VOICE_ACTIONS_STEPS } from './voice-actions-lib.mjs'

/** The plain meeting scenario: launch, a synthetic meeting, review, quit, relaunch. */
export const MEETING_STEPS = Object.freeze([
  'launch-and-renderer-ready',
  'meeting-live',
  'transcript-observed',
  'stop-and-save',
  'review-opens-meeting',
  'clean-quit',
  'relaunch',
  'meeting-preserved-after-relaunch',
  'final-quit'
])

/** soak.mjs is its own CLI; its single acceptance judgement is SOAK-ACCEPT-1 (soak-verdict.mjs). */
export const SOAK_STEPS = Object.freeze(['SOAK-ACCEPT-1'])

/**
 * Scenarios `run-acceptance.mjs --scenario` can run, in the order the CLI error lists them.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const SCENARIO_STEPS = Object.freeze({
  meeting: MEETING_STEPS,
  'settings-hig': SETTINGS_HIG_STEPS,
  upgrade: UPGRADE_STEPS,
  stress: Object.freeze(stressSteps(STRESS_CASES)),
  'voice-actions': VOICE_ACTIONS_STEPS,
  'quiet-mode': QUIET_MODE_STEPS,
  'memory-assistants': MEMORY_ASSISTANTS_STEPS
})

export const SCENARIOS = Object.freeze(Object.keys(SCENARIO_STEPS))

/** Every scenario the capability map may name: the runnable ones plus the separate soak CLI. */
export const MAP_SCENARIO_STEPS = Object.freeze({ ...SCENARIO_STEPS, soak: SOAK_STEPS })
