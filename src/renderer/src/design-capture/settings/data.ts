/**
 * Sample data of the Settings 2.0 design-capture states. Neutral placeholders only: organisation, workspace,
 * person and device names are generic, and no provider is named. Plain data with no DOM or JSX, so the
 * capture driver's tests can import it.
 */
export type SettingsDestinationId = 'general' | 'voice' | 'knowledge' | 'privacy'
export type SpeechChoice = 'not-chosen' | 'cloud-ready' | 'cloud-unavailable'
/** Lifecycle of the recommended optional local speech pack. */
export type LocalSpeechStage = 'review' | 'downloading' | 'installed'
export type PolicyId = 'managed' | 'changed-in-meeting'

/** What one Settings state shows. Everything else is derived from it. */
export interface SettingsScene {
  destination: SettingsDestinationId
  speech: SpeechChoice
  /** Search field text; a non-empty query replaces the destination with its matches. */
  search?: string
  advancedOpen?: boolean
  /** First open after upgrading: the two upgrade banners show above the destination. */
  migrated?: boolean
  /** Optional local speech: its own section of Voice & meetings, at this stage of the recommended pack. */
  localSpeech?: LocalSpeechStage
  /** Organisation policy in force (see orgPolicy): locked rows and hidden controls. */
  policy?: PolicyId
  /** The effective-policy sheet is open over the destination. */
  policySheet?: boolean
  /** A meeting is recording while Settings is open. */
  recording?: boolean
  /** The last save of this row failed: the row shows its previous value and an inline message. */
  saveFailed?: { rowId: string; attempted: string }
}

/** The parts of a scene that change row data rather than layout. */
export type SceneVariant = Pick<SettingsScene, 'localSpeech' | 'policy' | 'saveFailed'>

export type SettingsControl =
  | { kind: 'switch'; on: boolean }
  | { kind: 'value'; value: string; action?: string }
  | { kind: 'progress'; percent: number; value: string; action?: string }

export interface RowLock {
  owner: string
  /** The locked value; for a pending lock, the value it takes from the next meeting. */
  value: string
  reason: string
  /** Applies from the next meeting; until then the row keeps its current value. */
  pending: boolean
}

export interface SettingsRow {
  id: string
  label: string
  description: string
  /** Extra words the search matches besides the label. */
  keywords: readonly string[]
  control: SettingsControl
  lock?: RowLock
  /** Inline message after a failed save; the control then shows the value it reverted to. */
  saveError?: string
}

export interface SettingsSection {
  title: string
  rows: readonly SettingsRow[]
}

export interface SettingsDestination {
  id: SettingsDestinationId
  label: string
  /** Short readiness shown in the sidebar. */
  readiness: string
  /** One-sentence readiness summary shown under the destination heading. */
  summary: string
  sections: readonly SettingsSection[]
}

export const ADVANCED_LABEL = 'Advanced'
export const POLICY_OWNER = 'Example Org IT'

export interface SettingLock {
  rowId: string
  value: string
  reason: string
  pending?: boolean
}

export interface HiddenControl {
  rowId: string
  reason: string
}

export interface OrgPolicy {
  locks: readonly SettingLock[]
  hidden: readonly HiddenControl[]
}

const POLICIES: Readonly<Record<PolicyId, OrgPolicy>> = {
  managed: {
    locks: [
      { rowId: 'encrypt', value: 'On', reason: 'Every organisation computer keeps notes encrypted.' },
      { rowId: 'screen-share', value: 'On', reason: 'Notes must never appear in a shared screen.' },
      { rowId: 'app-calendar', value: 'Not allowed', reason: 'Calendar access waits for a security review.' }
    ],
    hidden: [
      { rowId: 'diagnostic-logging', reason: 'Detailed logs stay off on organisation computers.' },
      { rowId: 'export-diagnostics', reason: 'Support reports go through the IT team.' }
    ]
  },
  'changed-in-meeting': {
    locks: [
      { rowId: 'speech', value: 'Local speech only', reason: 'Meeting audio must stay on this computer.', pending: true }
    ],
    hidden: []
  }
}

const NO_POLICY: OrgPolicy = { locks: [], hidden: [] }

export function orgPolicy(id: PolicyId | undefined): OrgPolicy {
  return id ? POLICIES[id] : NO_POLICY
}

function row(
  id: string,
  label: string,
  description: string,
  keywords: readonly string[],
  control: SettingsControl
): SettingsRow {
  return { id, label, description, keywords, control }
}

const SPEECH_CONTROL: Readonly<Record<SpeechChoice, SettingsControl>> = {
  'not-chosen': { kind: 'value', value: 'Not chosen yet', action: 'Choose' },
  'cloud-ready': { kind: 'value', value: 'Cloud speech, ready', action: 'Change' },
  'cloud-unavailable': { kind: 'value', value: 'Cloud speech, offline', action: 'Retry' }
}

const VOICE_STATUS: Readonly<Record<SpeechChoice, { readiness: string; summary: string }>> = {
  'not-chosen': {
    readiness: 'Needs a choice',
    summary: 'Choose how speech is processed before your first meeting.'
  },
  'cloud-ready': {
    readiness: 'Ready',
    summary: 'Ready. Cloud speech is set up and the microphone is allowed.'
  },
  'cloud-unavailable': {
    readiness: 'Speech unavailable',
    summary: 'Cloud speech is unavailable while this computer is offline. Typing still works.'
  }
}

/** The recommended pack's control at each stage of its lifecycle. */
const RECOMMENDED_PACK_CONTROL: Readonly<Record<LocalSpeechStage, SettingsControl>> = {
  review: { kind: 'value', value: 'Compatible', action: 'Download' },
  downloading: { kind: 'progress', percent: 38, value: 'Downloading, 38%. Pauses during meetings.', action: 'Cancel' },
  installed: { kind: 'value', value: 'Installed, not selected', action: 'Use for speech' }
}

/** Optional local speech packs: one recommended and compatible, one unsupported here, one macOS only. */
function localSpeechRows(stage: LocalSpeechStage): readonly SettingsRow[] {
  return [
    row(
      'pack-standard',
      'Standard speech pack',
      'Recommended for this computer. A 1.4 GB download that starts only when you choose.',
      ['local speech', 'offline'],
      RECOMMENDED_PACK_CONTROL[stage]
    ),
    row(
      'pack-large',
      'Large speech pack',
      'Needs 12 GB of free memory; this computer has 6 GB free.',
      ['local speech', 'offline'],
      { kind: 'value', value: 'Not supported' }
    ),
    row(
      'pack-system',
      'System speech pack',
      'Uses the speech engine built into the operating system. Available on macOS only.',
      ['local speech', 'offline'],
      { kind: 'value', value: 'macOS only' }
    )
  ]
}

/** The four destinations as designed, before a policy or failed save is applied. */
function baseDestinations(speech: SpeechChoice, localSpeech?: LocalSpeechStage): readonly SettingsDestination[] {
  const speechUnavailable = speech === 'cloud-unavailable'
  return [
    {
      id: 'general',
      label: 'General',
      readiness: 'Ready',
      summary: 'Ready. Startup, appearance and updates use their defaults.',
      sections: [
        {
          title: 'Startup',
          rows: [
            row('open-at-login', 'Open at login', 'Start Métis when you sign in to this computer.', ['startup'], {
              kind: 'switch',
              on: false
            }),
            row('shortcut', 'Show or hide shortcut', 'Bring Métis forward from any app.', ['hotkey', 'keyboard'], {
              kind: 'value',
              value: 'Default shortcut',
              action: 'Change'
            })
          ]
        },
        {
          title: 'Appearance',
          rows: [
            row('theme', 'Theme', 'Light, dark or the same as the system.', ['dark mode', 'light mode'], {
              kind: 'value',
              value: 'Match system'
            }),
            row('app-language', 'Display language', 'Language of menus and labels.', ['locale'], {
              kind: 'value',
              value: 'English'
            })
          ]
        },
        {
          title: 'Updates',
          rows: [
            row('auto-update', 'Automatic updates', 'New versions install when you restart.', ['version'], {
              kind: 'switch',
              on: true
            })
          ]
        }
      ]
    },
    {
      id: 'voice',
      label: 'Voice & meetings',
      ...VOICE_STATUS[speech],
      sections: [
        {
          title: 'Microphone',
          rows: [
            row('mic-access', 'Microphone access', 'Métis listens only while a meeting is recording.', ['permission'], {
              kind: 'value',
              value: 'Allowed'
            }),
            row('input-device', 'Input device', 'The audio input Métis records from.', ['audio input'], {
              kind: 'value',
              value: 'Built-in microphone',
              action: 'Change'
            }),
            ...(speechUnavailable
              ? [
                  row(
                    'capture-issue',
                    'Meeting audio',
                    'Only your microphone is captured. Other people in the call are not heard.',
                    ['system audio', 'capture'],
                    { kind: 'value', value: 'Microphone only', action: 'Fix' }
                  )
                ]
              : [])
          ]
        },
        {
          title: 'Speech',
          rows: [
            row(
              'speech',
              'Speech processing',
              'Where your voice is turned into text.',
              ['transcription', 'cloud', 'on this device'],
              SPEECH_CONTROL[speech]
            ),
            ...(speechUnavailable
              ? [
                  row(
                    'local-speech',
                    'Local speech',
                    'Not selected, so Métis never switches to it on its own.',
                    ['offline', 'on this device'],
                    { kind: 'value', value: 'Not selected', action: 'Set up' }
                  )
                ]
              : []),
            row('spoken-language', 'Spoken language', 'The language people speak in your meetings.', ['dialect'], {
              kind: 'value',
              value: 'English'
            })
          ]
        },
        ...(localSpeech ? [{ title: 'Local speech (optional)', rows: localSpeechRows(localSpeech) }] : []),
        {
          title: 'Meetings',
          rows: [
            row('detect-meetings', 'Detect meetings', 'Offer to take notes when a call starts.', ['calendar'], {
              kind: 'switch',
              on: true
            }),
            row('save-notes', 'Save meeting notes', 'Keep a summary of every meeting on this computer.', ['notes'], {
              kind: 'switch',
              on: true
            })
          ]
        }
      ]
    },
    {
      id: 'knowledge',
      label: 'Knowledge & skills',
      readiness: 'Ready',
      summary: 'Ready. One notes folder is indexed and two of three skills are on.',
      sections: [
        {
          title: 'Knowledge',
          rows: [
            row('notes-folder', 'Notes folder', 'Métis answers from the notes in this folder.', ['documents'], {
              kind: 'value',
              value: 'Example notes',
              action: 'Change'
            }),
            row('index', 'Search index', 'Rebuilt when files in the folder change.', ['indexing'], {
              kind: 'value',
              value: 'Up to date'
            })
          ]
        },
        {
          title: 'Skills',
          rows: [
            row('skill-summary', 'Meeting summary', 'Write a short summary when a meeting ends.', ['recap'], {
              kind: 'switch',
              on: true
            }),
            row('skill-actions', 'Action items', 'List who does what next.', ['tasks', 'to-do'], {
              kind: 'switch',
              on: true
            }),
            row('skill-follow-up', 'Follow-up draft', 'Draft a follow-up message for you to review.', ['email'], {
              kind: 'switch',
              on: false
            })
          ]
        }
      ]
    },
    {
      id: 'privacy',
      label: 'Privacy & account',
      readiness: 'Ready',
      summary: 'Ready. Notes are encrypted on this computer and two apps are connected.',
      sections: [
        {
          title: 'Account',
          rows: [
            row('organisation', 'Organisation', 'The workspace your licence belongs to.', ['licence', 'company'], {
              kind: 'value',
              value: 'Example Org'
            }),
            row('signed-in', 'Signed in as', 'The account used on this computer.', ['profile', 'sign out'], {
              kind: 'value',
              value: 'Member A',
              action: 'Sign out'
            })
          ]
        },
        {
          title: 'Data protection',
          rows: [
            row('encrypt', 'Encrypt notes', 'Notes are unreadable without your account.', ['security'], {
              kind: 'switch',
              on: true
            }),
            row('screen-share', 'Hide from screen sharing', 'Others never see Métis in a shared screen.', ['capture'], {
              kind: 'switch',
              on: true
            })
          ]
        },
        {
          title: 'Connected apps',
          rows: [
            row('app-workspace-agent', 'Workspace agent', 'Reads the notes you choose to share.', ['integration'], {
              kind: 'value',
              value: 'Connected',
              action: 'Disconnect'
            }),
            row('app-task', 'Task app', 'Receives action items you approve.', ['integration'], {
              kind: 'value',
              value: 'Connected',
              action: 'Disconnect'
            }),
            row('app-calendar', 'Calendar app', 'Tells Métis when meetings start.', ['integration'], {
              kind: 'value',
              value: 'Not connected',
              action: 'Connect'
            })
          ]
        }
      ]
    }
  ]
}

/** Rows of the Advanced drawer. */
export const ADVANCED_ROWS: readonly SettingsRow[] = [
  row('diagnostic-logging', 'Diagnostic logging', 'Keep detailed logs for troubleshooting.', ['debug', 'logs'], {
    kind: 'switch',
    on: false
  }),
  row('hardware-acceleration', 'Hardware acceleration', 'Use the graphics processor when available.', ['gpu'], {
    kind: 'switch',
    on: true
  }),
  row('export-diagnostics', 'Export diagnostics', 'Save a report without meeting content.', ['support'], {
    kind: 'value',
    value: 'Report file',
    action: 'Export'
  }),
  row('reset', 'Reset all settings', 'Return every setting to its default.', ['defaults'], {
    kind: 'value',
    value: 'Keeps your notes',
    action: 'Reset'
  })
]

function withoutAction(control: SettingsControl): SettingsControl {
  return control.kind === 'switch' ? control : { ...control, action: undefined }
}

/** One row as the scene shows it: locked by policy, or reverted after a failed save. */
function applyVariant(r: SettingsRow, scene: SceneVariant): SettingsRow {
  const lock = orgPolicy(scene.policy).locks.find((l) => l.rowId === r.id)
  if (lock) {
    const pending = Boolean(lock.pending)
    // A pending lock keeps the current value in force, unchangeable, until the next meeting.
    const control: SettingsControl = pending ? withoutAction(r.control) : { kind: 'value', value: lock.value }
    return { ...r, control, lock: { owner: POLICY_OWNER, value: lock.value, reason: lock.reason, pending } }
  }
  const failed = scene.saveFailed
  if (failed?.rowId === r.id && r.control.kind === 'value') {
    return { ...r, saveError: `Couldn’t save “${failed.attempted}”. ${r.label} is back to ${r.control.value}.` }
  }
  return r
}

function hiddenBy(scene: SceneVariant): (r: SettingsRow) => boolean {
  const hidden = new Set(orgPolicy(scene.policy).hidden.map((h) => h.rowId))
  return (r) => hidden.has(r.id)
}

/** The four destinations, in sidebar order, as the scene shows them: hidden controls removed, locks applied. */
export function settingsDestinations(speech: SpeechChoice, scene: SceneVariant = {}): readonly SettingsDestination[] {
  const hidden = hiddenBy(scene)
  const policy = orgPolicy(scene.policy)
  return baseDestinations(speech, scene.localSpeech).map((d) => {
    const sections = d.sections.map((s) => ({
      ...s,
      rows: s.rows.filter((r) => !hidden(r)).map((r) => applyVariant(r, scene))
    }))
    if (d.id !== 'privacy' || scene.policy !== 'managed') return { ...d, sections }
    return {
      ...d,
      readiness: 'Managed',
      summary:
        `Ready. ${POLICY_OWNER} locks ${policy.locks.length} settings and hides ` +
        `${policy.hidden.length} controls on this computer.`,
      sections
    }
  })
}

/** Advanced drawer rows as the scene shows them. */
export function advancedRows(scene: SceneVariant = {}): readonly SettingsRow[] {
  const hidden = hiddenBy(scene)
  return ADVANCED_ROWS.filter((r) => !hidden(r)).map((r) => applyVariant(r, scene))
}

/** Every row as designed, hidden or not. */
function allRows(speech: SpeechChoice): readonly SettingsRow[] {
  return [...baseDestinations(speech).flatMap((d) => d.sections.flatMap((s) => s.rows)), ...ADVANCED_ROWS]
}

function rowLabel(rowId: string, speech: SpeechChoice): string {
  return allRows(speech).find((r) => r.id === rowId)?.label ?? rowId
}

/** Everyday words the search widens to the names Settings uses. */
export const SEARCH_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  mic: ['microphone', 'input device', 'speech'],
  hotkey: ['shortcut'],
  privacy: ['encrypt', 'screen sharing'],
  transcript: ['speech']
}

/** The query plus its synonyms, lower-cased: the terms a row may contain to match. */
export function searchTerms(query: string): readonly string[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return [q, ...(SEARCH_SYNONYMS[q] ?? [])]
}

/** True when the row's label or keywords contain one of the terms. */
function matcher(terms: readonly string[]): (r: SettingsRow) => boolean {
  return (r) => {
    const haystack = [r.label, ...r.keywords].join(' ').toLowerCase()
    return terms.some((t) => haystack.includes(t))
  }
}

export interface SearchGroup {
  label: string
  rows: readonly SettingsRow[]
}

/** Rows the scene shows whose label or keywords contain the query or one of its synonyms, grouped by destination. */
export function searchSettings(query: string, speech: SpeechChoice, scene: SceneVariant = {}): readonly SearchGroup[] {
  const terms = searchTerms(query)
  if (terms.length === 0) return []
  const matches = matcher(terms)
  const groups: SearchGroup[] = settingsDestinations(speech, scene).map((d) => ({
    label: d.label,
    rows: d.sections.flatMap((s) => s.rows).filter(matches)
  }))
  groups.push({ label: ADVANCED_LABEL, rows: advancedRows(scene).filter(matches) })
  return groups.filter((g) => g.rows.length > 0)
}

/** Controls the policy hides that the query would otherwise have matched. */
export function hiddenSearchMatches(
  query: string,
  speech: SpeechChoice,
  scene: SceneVariant = {}
): readonly SettingsRow[] {
  const terms = searchTerms(query)
  if (terms.length === 0) return []
  return allRows(speech).filter(hiddenBy(scene)).filter(matcher(terms))
}

export interface PolicySheetRow {
  setting: string
  value: string
  source: string
  why: string
}

/** The effective-policy sheet: one row per locked or hidden control, with who sets it and why. */
export function effectivePolicy(id: PolicyId, speech: SpeechChoice): readonly PolicySheetRow[] {
  const policy = orgPolicy(id)
  return [
    ...policy.locks.map((l) => ({
      setting: rowLabel(l.rowId, speech),
      value: l.pending ? `${l.value}, from the next meeting` : l.value,
      source: POLICY_OWNER,
      why: l.reason
    })),
    ...policy.hidden.map((h) => ({
      setting: rowLabel(h.rowId, speech),
      value: 'Hidden',
      source: POLICY_OWNER,
      why: h.reason
    }))
  ]
}

export interface SettingsNotice {
  title: string
  body: string
  /** A warning interrupts (role alert); an info notice does not (role status). */
  tone: 'info' | 'warning'
  action?: string
}

/** The notices shown above the destination for this scene, in order. */
export function sceneNotices(scene: SettingsScene): readonly SettingsNotice[] {
  const notices: SettingsNotice[] = []
  if (scene.speech === 'cloud-unavailable') {
    notices.push({
      title: 'Cloud speech unavailable',
      body: 'This computer is offline. Typing still works, and Métis does not switch to local speech on its own.',
      tone: 'info'
    })
  }
  if (scene.policy === 'managed') {
    notices.push({
      title: `Some settings are managed by ${POLICY_OWNER}`,
      body: 'Locked settings show who manages them and why.',
      tone: 'info',
      action: 'View effective policy'
    })
  }
  for (const lock of orgPolicy(scene.policy).locks.filter((l) => l.pending)) {
    notices.push({
      title: 'Your organisation changed a policy during this meeting',
      body:
        `${rowLabel(lock.rowId, scene.speech)} becomes ${lock.value} from your next meeting. ` +
        'This meeting keeps its current speech setting.',
      tone: 'warning'
    })
  }
  return notices
}
