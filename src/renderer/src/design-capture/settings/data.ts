/**
 * Sample data of the Settings 2.0 design-capture states. Neutral placeholders only: organisation, workspace,
 * person and device names are generic, and no provider is named. Plain data with no DOM or JSX, so the
 * capture driver's tests can import it.
 */
export type SettingsDestinationId = 'general' | 'voice' | 'knowledge' | 'privacy'
export type SpeechChoice = 'not-chosen' | 'cloud-ready'

/** What one Settings state shows. Everything else is derived from it. */
export interface SettingsScene {
  destination: SettingsDestinationId
  speech: SpeechChoice
  /** Search field text; a non-empty query replaces the destination with its matches. */
  search?: string
  advancedOpen?: boolean
  /** First open after upgrading: the two upgrade banners show above the destination. */
  migrated?: boolean
}

export type SettingsControl =
  | { kind: 'switch'; on: boolean }
  | { kind: 'value'; value: string; action?: string }

export interface SettingsRow {
  id: string
  label: string
  description: string
  /** Extra words the search matches besides the label. */
  keywords: readonly string[]
  control: SettingsControl
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

function row(
  id: string,
  label: string,
  description: string,
  keywords: readonly string[],
  control: SettingsControl
): SettingsRow {
  return { id, label, description, keywords, control }
}

/** The four destinations, in sidebar order. */
export function settingsDestinations(speech: SpeechChoice): readonly SettingsDestination[] {
  const speechReady = speech === 'cloud-ready'
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
      readiness: speechReady ? 'Ready' : 'Needs a choice',
      summary: speechReady
        ? 'Ready. Cloud speech is set up and the microphone is allowed.'
        : 'Choose how speech is processed before your first meeting.',
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
            })
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
              speechReady
                ? { kind: 'value', value: 'Cloud speech, ready', action: 'Change' }
                : { kind: 'value', value: 'Not chosen yet', action: 'Choose' }
            ),
            row('spoken-language', 'Spoken language', 'The language people speak in your meetings.', ['dialect'], {
              kind: 'value',
              value: 'English'
            })
          ]
        },
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

export interface SearchGroup {
  label: string
  rows: readonly SettingsRow[]
}

/** Rows whose label or keywords contain the query or one of its synonyms, grouped by destination. */
export function searchSettings(query: string, speech: SpeechChoice): readonly SearchGroup[] {
  const terms = searchTerms(query)
  if (terms.length === 0) return []
  const matches = (r: SettingsRow): boolean => {
    const haystack = [r.label, ...r.keywords].join(' ').toLowerCase()
    return terms.some((t) => haystack.includes(t))
  }
  const groups: SearchGroup[] = settingsDestinations(speech).map((d) => ({
    label: d.label,
    rows: d.sections.flatMap((s) => s.rows).filter(matches)
  }))
  groups.push({ label: ADVANCED_LABEL, rows: ADVANCED_ROWS.filter(matches) })
  return groups.filter((g) => g.rows.length > 0)
}
