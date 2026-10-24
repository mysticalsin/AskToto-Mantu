/**
 * Settings › Privacy "Your data" (G83): one row per kind of data Métis keeps, saying what it reads, where it is stored,
 * whether it leaves this Mac, how long it is kept and how to remove it. Copy only: nothing here reads a file, and the
 * renderer shows no path. `userDataEntries`, `routerCapabilities` and `speechEngines` exist for the inventory test,
 * which fails when main writes a userData entry, or ships a capability or engine, that no row discloses.
 * Every row cites the modules its claims come from; a field the evidence does not support says "Not yet stated".
 */
import { z } from 'zod'
import { ROUTER_CAPABILITIES } from './capability-router'
import { SpeechEngineIdSchema } from './contracts/capability'
import { PrivacyClassSchema } from './contracts/privacy-class'
import { OPERATOR_REPORTING_DETAIL, OPERATOR_REPORTING_DISCLOSURE } from './operator'

export const LEAVES_DEVICE = ['never', 'on-your-action', 'when-you-turn-it-on', 'synced-by-your-cloud-folder'] as const
export type LeavesDevice = (typeof LEAVES_DEVICE)[number]

export const DISCLOSURE_KINDS = ['personal', 'secret', 'app-component'] as const
export type DisclosureKind = (typeof DISCLOSURE_KINDS)[number]

/** Badge words for the collapsed row; always shown as text, never as colour alone. */
export const LEAVES_DEVICE_LABEL: Readonly<Record<LeavesDevice, string>> = Object.freeze({
  never: 'On this Mac only',
  'on-your-action': 'When you ask',
  'when-you-turn-it-on': 'When you turn it on',
  'synced-by-your-cloud-folder': 'Synced by your cloud folder'
})

export const DISCLOSURE_KIND_LABEL: Readonly<Record<DisclosureKind, string>> = Object.freeze({
  personal: 'Your content',
  secret: 'Sign-in and keys',
  'app-component': 'App components'
})

export const DataDisclosureSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
    kind: z.enum(DISCLOSURE_KINDS),
    title: z.string().min(1).max(40),
    reads: z.string().min(1).max(160),
    storedAt: z.string().min(1).max(120),
    privacyClass: PrivacyClassSchema,
    leavesDevice: z.enum(LEAVES_DEVICE),
    leavesDeviceDetail: z.string().max(320),
    retention: z.string().min(1).max(160),
    howToDelete: z.string().min(1).max(160),
    userDataEntries: z.array(z.string().min(1)).default([]),
    meetingsFolder: z.boolean().default(false),
    routerCapabilities: z.array(z.enum(ROUTER_CAPABILITIES)).default([]),
    speechEngines: z.array(SpeechEngineIdSchema).default([]),
    // Module specifiers from the repository root, without extension, e.g. 'src/main/speaker-id'.
    evidence: z.array(z.string().regex(/^src\/[A-Za-z0-9/_.-]+$/)).min(1)
  })
  .strict()
  .superRefine((row, ctx) => {
    if ((row.leavesDevice === 'never') !== (row.leavesDeviceDetail === '')) {
      ctx.addIssue({ code: 'custom', message: 'leavesDeviceDetail is empty exactly when leavesDevice is never' })
    }
    if (row.kind === 'secret' && row.privacyClass !== 'P4') {
      ctx.addIssue({ code: 'custom', message: 'secret rows are P4' })
    }
    if (row.meetingsFolder && row.leavesDevice !== 'synced-by-your-cloud-folder') {
      ctx.addIssue({ code: 'custom', message: 'the meetings folder row is synced by the owner cloud folder' })
    }
  })

export type DataDisclosure = z.infer<typeof DataDisclosureSchema>

/** Mirrors LIVE_MEETING_JOURNAL_RETENTION (main/features/meetings/journal-recovery); a test pins the two together. */
export const LIVE_MEETING_JOURNAL_RETENTION_COPY = 'Unsaved live-meeting journals: up to 14 days, at most 10.'

const NOT_YET_STATED = 'Not yet stated.'
const ON_THIS_MAC = 'Métis app data on this Mac.'

const ROWS: readonly z.input<typeof DataDisclosureSchema>[] = [
  {
    id: 'meeting-transcripts',
    kind: 'personal',
    title: 'Meeting transcripts',
    reads: 'What is said in meetings you record, as text, with the title and notes you add.',
    storedAt: 'Your Métis Meetings folder (in OneDrive when Métis finds it, otherwise Documents).',
    privacyClass: 'P2',
    leavesDevice: 'synced-by-your-cloud-folder',
    leavesDeviceDetail:
      'Métis writes the files to your meetings folder. If that folder is in OneDrive, your OneDrive app syncs it; Métis does not upload it.',
    retention: `Saved meetings follow the retention window in Settings › Meetings. ${LIVE_MEETING_JOURNAL_RETENTION_COPY}`,
    howToDelete:
      'Shorten the retention window in Settings › Meetings (it says how many meetings it will delete and asks first), or delete the files.',
    meetingsFolder: true,
    userDataEntries: ['transcript-receipts', 'export-receipts.jsonl', 'import-jobs'],
    evidence: [
      'src/main/infra/storage/paths',
      'src/main/features/meetings/journal-recovery',
      'src/main/features/meetings/main-save-receipts',
      'src/main/import-job-store',
      'src/shared/contracts/settings-os-state'
    ]
  },
  {
    id: 'speech-audio',
    kind: 'personal',
    title: 'Meeting audio',
    reads: 'Your microphone and system audio while you record, turned into text.',
    storedAt: 'The text is saved with the meeting. Raw audio storage: not yet stated.',
    privacyClass: 'P2',
    leavesDevice: 'on-your-action',
    leavesDeviceDetail:
      'Parakeet and Whisper run on this Mac. A cloud engine (Deepgram, Cloudflare or Soniox) receives audio only after you accept its prompt. Apple speech uses the macOS speech service.',
    retention: 'At a cloud engine: kept by that provider under its own terms.',
    howToDelete:
      'Choose an on-device engine in Settings › Audio to stop sending audio out. Delete the meeting to remove its text.',
    speechEngines: [...SpeechEngineIdSchema.options],
    evidence: [
      'src/renderer/src/lib/cloud-speech-consent',
      'src/shared/contracts/stt-provider',
      'src/shared/contracts/capability/index'
    ]
  },
  {
    id: 'ai-answers',
    kind: 'personal',
    title: 'Questions and AI answers',
    reads: 'The question you ask and the meeting or screen context it needs.',
    storedAt: 'With the meeting it belongs to, when you save that meeting.',
    privacyClass: 'P2',
    leavesDevice: 'on-your-action',
    leavesDeviceDetail:
      'When you ask, the question and its context go to the AI model you set up in Settings › AI. A local model keeps them on this Mac. Screen questions are blocked while Private View is on.',
    retention: 'At a cloud model: kept by that provider under its own terms.',
    howToDelete: 'Delete the meeting. Remove a provider with Settings › AI › Disconnect.',
    routerCapabilities: [...ROUTER_CAPABILITIES],
    evidence: ['src/shared/capability-router', 'src/main/credential-clearers', 'src/shared/contracts/privacy-class']
  },
  {
    id: 'screen-captures',
    kind: 'personal',
    title: 'Screen captures',
    reads: 'Your screen, only when you ask: the Capture button, its shortcut, or Enter with an empty box.',
    storedAt: ON_THIS_MAC,
    privacyClass: 'P2',
    leavesDevice: 'on-your-action',
    leavesDeviceDetail:
      'A screen question sends the capture to the AI model you chose. Nothing is captured while Private View is on.',
    retention: NOT_YET_STATED,
    howToDelete: 'Turn off "Let Métis see your screen on request" in Settings › Privacy.',
    userDataEntries: ['context-snapshots'],
    evidence: ['src/main/features/context-grants/compose']
  },
  {
    id: 'voiceprints',
    kind: 'personal',
    title: 'Speaker voices',
    reads: 'Voice samples of speakers you name, kept as voice signatures to recognise them later.',
    storedAt: ON_THIS_MAC,
    privacyClass: 'P2',
    leavesDevice: 'never',
    leavesDeviceDetail: '',
    retention: NOT_YET_STATED,
    howToDelete: NOT_YET_STATED,
    userDataEntries: ['voiceprints.json'],
    evidence: ['src/main/speaker-id']
  },
  {
    id: 'meeting-graph',
    kind: 'personal',
    title: 'Meeting graph',
    reads: 'People, topics and links Métis draws from your saved meetings.',
    storedAt: ON_THIS_MAC,
    privacyClass: 'P2',
    leavesDevice: 'never',
    leavesDeviceDetail: '',
    retention: NOT_YET_STATED,
    howToDelete: NOT_YET_STATED,
    userDataEntries: ['graph'],
    evidence: ['src/main/graphify']
  },
  {
    id: 'user-memory',
    kind: 'personal',
    title: 'Memory and dictation',
    reads: 'Facts you ask Métis to remember, and your dictation history and personal dictionary.',
    storedAt: 'Métis app data on this Mac, sealed separately for each signed-in owner.',
    privacyClass: 'P2',
    leavesDevice: 'never',
    leavesDeviceDetail: '',
    retention: 'Remembered items stay until you delete them. Dictation history: not yet stated.',
    howToDelete: 'Delete a remembered item in Settings › Privacy. Dictation history: not yet stated.',
    userDataEntries: ['user-memory', 'dictation-memory'],
    evidence: ['src/main/lifecycle/user-memory-wiring', 'src/main/features/dictation/dictation-memory']
  },
  {
    id: 'assistants',
    kind: 'personal',
    title: 'Assistants',
    reads: 'Assistants you create and their instructions.',
    storedAt: 'Métis app data on this Mac, one file for each signed-in owner.',
    privacyClass: 'P2',
    leavesDevice: 'never',
    leavesDeviceDetail: '',
    retention: 'Archived assistants are kept. Removal: not yet stated.',
    howToDelete: 'Archive the assistant to stop using it. Removing its file: not yet stated.',
    userDataEntries: ['assistants'],
    evidence: ['src/main/lifecycle/assistants-wiring']
  },
  {
    id: 'connected-tools',
    kind: 'personal',
    title: 'Connected tools',
    reads: 'Your connected tool accounts, and actions you send to them, such as next steps for a CRM.',
    storedAt: ON_THIS_MAC,
    privacyClass: 'P2',
    leavesDevice: 'on-your-action',
    leavesDeviceDetail:
      'An action goes to the tool when you send it; a failed send is retried later. Actions from confidential meetings are never sent.',
    retention: 'Queued actions stay until they are sent or given up.',
    howToDelete: NOT_YET_STATED,
    userDataEntries: ['connector-accounts', 'mcp-push-queue.json'],
    evidence: ['src/main/features/connectors/account-store', 'src/main/mcp/pushQueue']
  },
  {
    id: 'desktop-tasks',
    kind: 'personal',
    title: 'Desktop tasks',
    reads: 'Desktop commands you confirm, and what happened when they ran.',
    storedAt: 'Métis app data on this Mac; task history is encrypted.',
    privacyClass: 'P2',
    leavesDevice: 'never',
    leavesDeviceDetail: '',
    retention: NOT_YET_STATED,
    howToDelete: NOT_YET_STATED,
    userDataEntries: ['desktop-action-tasks.bin', 'desktop-action-acks.json', 'task-browser-disclosure.txt'],
    evidence: ['src/main/tasks/desktop-action-task-runtime', 'src/main/task-browser/task-browser-runtime']
  },
  {
    id: 'usage-and-logs',
    kind: 'personal',
    title: 'Logs and diagnostics',
    reads: 'How the app is running: errors, timings, crash reports and time-saved counts.',
    storedAt: ON_THIS_MAC,
    privacyClass: 'P1',
    leavesDevice: 'on-your-action',
    leavesDeviceDetail: 'Sent only when you create and share a support bundle from Settings.',
    retention: NOT_YET_STATED,
    howToDelete: NOT_YET_STATED,
    userDataEntries: [
      'logs',
      'time-saved.jsonl',
      'diagnostics',
      'Crashpad',
      'smoke-park-state.json',
      'boot-incomplete.json'
    ],
    evidence: [
      'src/main/logger',
      'src/main/time-saved-log',
      'src/main/infra/observability/stall-bundle',
      'src/main/features/export/diagnostics-bundle'
    ]
  },
  {
    id: 'org-reporting',
    kind: 'personal',
    title: 'Organisation reporting',
    reads: 'Usage and health of the app, never meeting content.',
    storedAt: 'Your organisation settings are kept in Métis app data on this Mac.',
    privacyClass: 'P1',
    leavesDevice: 'when-you-turn-it-on',
    leavesDeviceDetail: `${OPERATOR_REPORTING_DISCLOSURE} ${OPERATOR_REPORTING_DETAIL}`,
    retention: NOT_YET_STATED,
    howToDelete: 'Your organisation controls this; see Organisation reporting in Settings › Privacy.',
    userDataEntries: ['managed-config.json'],
    evidence: ['src/shared/operator', 'src/main/operator-enrollment-runtime']
  },
  {
    id: 'sign-in-and-keys',
    kind: 'secret',
    title: 'Sign-in and keys',
    reads: 'Your sign-in session, license and the keys Métis uses to reach services.',
    storedAt: 'Métis app data on this Mac; the sign-in session is encrypted.',
    privacyClass: 'P4',
    leavesDevice: 'never',
    leavesDeviceDetail: '',
    retention: 'Until you sign out or disconnect.',
    howToDelete: 'Sign out in Settings, or remove a provider key with Settings › AI › Disconnect.',
    userDataEntries: [
      'auth-session.bin',
      'msal-cache.bin',
      'auth-lkg-config.json',
      'auth-configured.flag',
      'license-cache.bin',
      '.cloudflare-key-seeded',
      'machine-id.txt',
      'identity',
      'identity.json'
    ],
    evidence: [
      'src/main/auth',
      'src/main/license/secret-store',
      'src/main/license/install',
      'src/main/credential-clearers',
      'src/main/lifecycle/owner-session-authority'
    ]
  },
  {
    id: 'app-components',
    kind: 'app-component',
    title: 'Speech and AI models',
    reads: 'Nothing personal: downloaded models, speech packs, helper tools and running-process records.',
    storedAt: ON_THIS_MAC,
    privacyClass: 'P0',
    leavesDevice: 'never',
    leavesDeviceDetail: '',
    retention: 'Until you delete Métis app data.',
    howToDelete: 'Dragging Métis to the Trash does not remove them; delete Métis app data.',
    userDataEntries: [
      'asr-models',
      'local-llm',
      'speech-packs',
      'managed-node',
      'managed-cli',
      'vcredist',
      'skills-overrides',
      'run'
    ],
    evidence: [
      'src/main/asr-model-download',
      'src/main/llm/local-models',
      'src/main/managed-node',
      'src/main/cli-installer',
      'src/main/infra/process/registry'
    ]
  }
]

export const DATA_DISCLOSURES: readonly DataDisclosure[] = Object.freeze(
  ROWS.map((row) => Object.freeze(DataDisclosureSchema.parse(row)))
)
