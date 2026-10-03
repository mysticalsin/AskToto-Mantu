/**
 * State list of the design-capture surface, with neutral sample data only. The capture job reads
 * `DESIGN_CAPTURE_STATES` (id and viewport) from the running page, so this list is the single source of what
 * gets screenshotted and at which size.
 * The first six are placeholder states for the capture pipeline, not the M2-0201 prototype state list; the
 * `S..` states are the Settings 2.0 states S01-S17 (M2-0450 and M2-0451), rendered by settings/SettingsSurface.tsx.
 *
 * BLOCKED_EXTERNAL: the lead supplies the M2-0201 prototype manifest state ids from the program tracker; they
 * replace `DESIGN_STATES` in this file one to one before the capture job's artifact is filed as M2-0201 evidence.
 */
import { SETTINGS_WINDOW_MIN } from '@shared/settings-bounds'
import type { SettingsScene } from './settings/data'

export type DesignPhase = 'idle' | 'listening'

export interface DesignViewport {
  width: number
  height: number
}

export type SettingsStateId =
  | 'S01-general'
  | 'S02-voice-ready'
  | 'S03-voice-unavailable'
  | 'S04-local-speech-review'
  | 'S05-local-speech-downloading'
  | 'S06-local-speech-installed'
  | 'S07-knowledge'
  | 'S08-privacy-managed'
  | 'S09-policy-sheet'
  | 'S10-advanced'
  | 'S11-search'
  | 'S12-search-empty'
  | 'S13-save-failed'
  | 'S14-policy-changed'
  | 'S15-narrow'
  | 'S16-migrated'
  | 'S17-connected-apps'

export type DesignState =
  | { id: 'bar-idle'; kind: 'bar'; title: string; phase: 'idle' }
  | { id: 'bar-listening'; kind: 'bar'; title: string; phase: 'listening' }
  | { id: 'answer-streaming'; kind: 'answer'; title: string; streaming: true }
  | { id: 'answer-complete'; kind: 'answer'; title: string; streaming: false }
  | { id: 'review-summary'; kind: 'review'; title: string }
  | { id: 'error-recoverable'; kind: 'error'; title: string }
  | { id: 'audit-negative-control'; kind: 'audit-negative-control'; title: string }
  | { id: SettingsStateId; kind: 'settings'; title: string; scene: SettingsScene; viewport?: DesignViewport }

/** Viewport of every non-Settings state and of the QA negative control (the M2-0418 capture size). */
export const DEFAULT_VIEWPORT: DesignViewport = { width: 960, height: 640 }
/** A Settings state opens at the Settings window's minimum size unless it names its own viewport. */
export const SETTINGS_VIEWPORT: DesignViewport = SETTINGS_WINDOW_MIN
export const NARROW_SETTINGS_VIEWPORT: DesignViewport = { width: 360, height: 720 }

export const DESIGN_STATES: readonly DesignState[] = [
  { id: 'bar-idle', kind: 'bar', title: 'Bar, idle', phase: 'idle' },
  { id: 'bar-listening', kind: 'bar', title: 'Bar, listening', phase: 'listening' },
  { id: 'answer-streaming', kind: 'answer', title: 'Answer, streaming', streaming: true },
  { id: 'answer-complete', kind: 'answer', title: 'Answer, complete', streaming: false },
  { id: 'review-summary', kind: 'review', title: 'Review, summary' },
  { id: 'error-recoverable', kind: 'error', title: 'Error, recoverable' },
  {
    id: 'S01-general',
    kind: 'settings',
    title: 'General, fresh install',
    scene: { destination: 'general', speech: 'not-chosen' }
  },
  {
    id: 'S02-voice-ready',
    kind: 'settings',
    title: 'Voice & meetings, cloud speech ready',
    scene: { destination: 'voice', speech: 'cloud-ready' }
  },
  {
    id: 'S03-voice-unavailable',
    kind: 'settings',
    title: 'Cloud speech unavailable, no silent switch',
    scene: { destination: 'voice', speech: 'cloud-unavailable' }
  },
  {
    id: 'S04-local-speech-review',
    kind: 'settings',
    title: 'Optional local speech, review before download',
    scene: { destination: 'voice', speech: 'cloud-ready', localSpeech: 'review' }
  },
  {
    id: 'S05-local-speech-downloading',
    kind: 'settings',
    title: 'Optional local speech, downloading',
    scene: { destination: 'voice', speech: 'cloud-ready', localSpeech: 'downloading' }
  },
  {
    id: 'S06-local-speech-installed',
    kind: 'settings',
    title: 'Optional local speech, installed but not selected',
    scene: { destination: 'voice', speech: 'cloud-ready', localSpeech: 'installed' }
  },
  {
    id: 'S07-knowledge',
    kind: 'settings',
    title: 'Knowledge & skills',
    scene: { destination: 'knowledge', speech: 'cloud-ready' }
  },
  {
    id: 'S08-privacy-managed',
    kind: 'settings',
    title: 'Privacy & account with organization locks',
    scene: { destination: 'privacy', speech: 'cloud-ready', policy: 'managed' }
  },
  {
    id: 'S09-policy-sheet',
    kind: 'settings',
    title: 'Effective policy',
    scene: { destination: 'privacy', speech: 'cloud-ready', policy: 'managed', policySheet: true }
  },
  {
    id: 'S10-advanced',
    kind: 'settings',
    title: 'Advanced drawer',
    scene: { destination: 'general', speech: 'cloud-ready', advancedOpen: true }
  },
  {
    id: 'S11-search',
    kind: 'settings',
    title: 'Search with synonyms',
    scene: { destination: 'voice', speech: 'cloud-ready', search: 'mic' }
  },
  {
    id: 'S12-search-empty',
    kind: 'settings',
    title: 'Search for a control hidden by policy',
    scene: { destination: 'privacy', speech: 'cloud-ready', policy: 'managed', search: 'diagnostic' }
  },
  {
    id: 'S13-save-failed',
    kind: 'settings',
    title: 'Save failed, value reverted',
    scene: { destination: 'general', speech: 'cloud-ready', saveFailed: { rowId: 'theme', attempted: 'Dark' } }
  },
  {
    id: 'S14-policy-changed',
    kind: 'settings',
    title: 'Policy changed during a meeting',
    scene: {
      destination: 'voice',
      speech: 'cloud-ready',
      localSpeech: 'installed',
      policy: 'changed-in-meeting',
      recording: true
    }
  },
  {
    id: 'S15-narrow',
    kind: 'settings',
    title: 'Narrow window',
    scene: { destination: 'voice', speech: 'cloud-ready' },
    viewport: NARROW_SETTINGS_VIEWPORT
  },
  {
    id: 'S16-migrated',
    kind: 'settings',
    title: 'First open after upgrading',
    scene: { destination: 'general', speech: 'not-chosen', migrated: true }
  },
  {
    id: 'S17-connected-apps',
    kind: 'settings',
    title: 'Privacy & account, connected apps',
    scene: { destination: 'privacy', speech: 'cloud-ready' }
  }
]

export const DESIGN_STATE_IDS: readonly string[] = DESIGN_STATES.map((s) => s.id)

/** The viewport a state is captured at. */
export function designStateViewport(state: DesignState): DesignViewport {
  if (state.kind === 'settings') return state.viewport ?? SETTINGS_VIEWPORT
  return DEFAULT_VIEWPORT
}

/** What the page exposes to the capture driver: each listed state with the viewport it is captured at. */
export const DESIGN_CAPTURE_STATES: readonly { id: string; viewport: DesignViewport }[] = DESIGN_STATES.map(
  (s) => ({ id: s.id, viewport: designStateViewport(s) })
)
export const AUDIT_NEGATIVE_CONTROL_STATE: DesignState = {
  id: 'audit-negative-control',
  kind: 'audit-negative-control',
  title: 'Audit negative control'
}

export const SAMPLE_QUESTION = 'What did we agree about the sample rollout?'
export const SAMPLE_ANSWER = [
  'The sample rollout starts with a small pilot group.',
  'Owners review the pilot results before the wider launch.'
]
export const SAMPLE_REVIEW = {
  title: 'Sample planning meeting',
  decisions: ['Start with a small pilot group', 'Review results before the wider launch'],
  actions: ['Owner A drafts the pilot checklist', 'Owner B schedules the review']
}

/** The state named by a `?state=<id>` query string, or undefined when absent or not in the list. */
export function resolveDesignState(search: string): DesignState | undefined {
  const id = new URLSearchParams(search).get('state')
  return DESIGN_STATES.find((s) => s.id === id)
}

/** QA-only state for the audit driver. It is addressable by query string but never listed for evidence shots. */
export function resolveDesignStateIncludingQa(search: string): DesignState | undefined {
  const id = new URLSearchParams(search).get('state')
  if (id === AUDIT_NEGATIVE_CONTROL_STATE.id) return AUDIT_NEGATIVE_CONTROL_STATE
  return DESIGN_STATES.find((s) => s.id === id)
}
