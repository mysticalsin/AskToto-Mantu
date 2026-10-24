/**
 * The data-store inventory (Métis 2.12 G82, CAP-35 / R093).
 *
 * One typed list of every place the desktop app keeps owner data. The erasure orchestrator
 * (main/features/data-rights), the export, the contract test that fails when a persisted store is missing here, and
 * G83's disclosure table all read this list, so a store cannot be added in one place and forgotten in another.
 * Same idea as shared/credential-inventory.ts, which owns credentials: the `credentials` row is erased by running
 * G20's `accountSwitch` cleanup, so they are not listed twice.
 *
 * Policy, labelled ASSUMED until the owner reviews it (every cell is data, so flipping one is a one-line change):
 *  - Kept after erasure: the audit hash chain (content-free), the erasure receipt log (it is the proof), the
 *    identity folder (partition ledger, owner salt, erasure fence: needed to recognise the owner and keep the
 *    fence), and settings (a reset is G20's archive flow).
 *  - Ask and conversation history has no persisted store: turns live in memory and in the encrypted meeting files.
 *  - Not owner data, so not listed: model packs, the managed Node/CLI installs, the licence cache, machine id and
 *    key files, the boot sentinel and sidecar run state.
 *
 * Pure and Electron free.
 */

export type DataStoreId =
  | 'meetings'
  | 'meeting-drafts'
  | 'meeting-journal'
  | 'save-receipts'
  | 'import-jobs'
  | 'dictation-memory'
  | 'brain'
  | 'brain-backup'
  | 'brain-preserved'
  | 'wiki'
  | 'graph'
  | 'assistants'
  | 'user-memory'
  | 'context-snapshots'
  | 'connector-accounts'
  | 'desktop-tasks'
  | 'desktop-task-acks'
  | 'voiceprints'
  | 'artifacts-registry'
  | 'task-browser-profile'
  | 'operator-outbox'
  | 'mcp-push-queue'
  | 'history-cache'
  | 'crash-logs'
  | 'stall-bundles'
  | 'responsiveness-report'
  | 'time-saved-log'
  | 'export-receipts'
  | 'main-log'
  | 'credentials'
  | 'audit-log'
  | 'erasure-receipts'
  | 'identity'
  | 'settings'
  | 'memory-server'
  | 'operator-records'
  | 'cloud-sync-copies'

export type DataClass =
  | 'meeting-content'
  | 'derived-knowledge'
  | 'memory'
  | 'assistant'
  | 'dictation'
  | 'task'
  | 'connector'
  | 'cache'
  | 'journal'
  | 'log'
  | 'receipt'
  | 'biometric'
  | 'outbox'
  | 'credential'
  | 'remote'

export type DataLocation = 'meetings-folder' | 'user-data' | 'partition' | 'memory' | 'remote'
export type DataEncryption = 'always' | 'setting' | 'never'
export type DataScope = 'owner-partition' | 'device' | 'remote-tenant'
/** `delete` is erased by the orchestrator; `retain` is kept on purpose; `external` is outside Métis's reach. */
export type DataErasePolicy = 'delete' | 'retain' | 'external'
export type ErasurePhase = 1 | 2 | 3 | 4 | 5

export interface DataStoreEntry {
  readonly id: DataStoreId
  readonly label: string
  readonly dataClass: DataClass
  readonly location: DataLocation
  readonly encryptedAtRest: DataEncryption
  readonly scope: DataScope
  readonly erase: DataErasePolicy
  /** Required for `retain` and `external`: the closed code the receipt carries. */
  readonly reason?: string
  readonly exportable: boolean
  /** Required for `delete`. 1 quiesce, 2 sources, 3 derived, 4 caches and logs, 5 remote and credentials. */
  readonly phase?: ErasurePhase
  /** What can write this store again after it was erased: the places the no-resurrection fence guards. */
  readonly recreatedBy: readonly string[]
  /**
   * Names of the persisted files or folders this store is defined by. The contract test checks each name still
   * appears in `owner` (a module path relative to src/main), so a rename cannot leave the inventory behind.
   */
  readonly names?: readonly string[]
  readonly owner?: string
  /** Files or folders under userData the erasure removes whole (device-wide stores). */
  readonly paths?: readonly string[]
  /** Files under userData that belong to one memory partition (`{pid}` is the owner's partition id): only this owner's goes. */
  readonly partitionPaths?: readonly string[]
}

type Row = Omit<DataStoreEntry, 'erase' | 'exportable' | 'recreatedBy'> &
  Partial<Pick<DataStoreEntry, 'erase' | 'exportable' | 'recreatedBy'>>

const row = (e: Row): DataStoreEntry => ({ erase: 'delete', exportable: false, recreatedBy: [], ...e })

export const DATA_STORES: readonly DataStoreEntry[] = [
  row({
    id: 'meetings',
    label: 'Saved meetings and transcripts',
    dataClass: 'meeting-content',
    location: 'meetings-folder',
    encryptedAtRest: 'setting',
    scope: 'owner-partition',
    exportable: true,
    phase: 2,
    recreatedBy: ['cloud sync', 'save receipt replay', 'journal recovery', 'legacy folder copy-forward']
  }),
  row({
    id: 'meeting-drafts',
    label: 'Unsaved meeting drafts',
    dataClass: 'meeting-content',
    location: 'meetings-folder',
    encryptedAtRest: 'setting',
    scope: 'owner-partition',
    phase: 2,
    recreatedBy: ['orphan draft promotion', 'cloud sync']
  }),
  row({
    id: 'meeting-journal',
    label: 'Live meeting journals',
    dataClass: 'journal',
    location: 'user-data',
    encryptedAtRest: 'always',
    scope: 'device',
    phase: 2,
    recreatedBy: ['journal-only promotion'],
    names: ['meeting-journal'],
    owner: 'infra/storage/meeting-journal-purge.ts',
    paths: ['meeting-journal']
  }),
  row({
    id: 'save-receipts',
    label: 'Saved-transcript receipts',
    dataClass: 'receipt',
    location: 'user-data',
    encryptedAtRest: 'never',
    scope: 'device',
    phase: 2,
    recreatedBy: ['save receipt replay'],
    names: ['transcript-receipts'],
    owner: 'features/meetings/main-save-receipts.ts',
    paths: ['transcript-receipts']
  }),
  row({
    id: 'import-jobs',
    label: 'Import jobs',
    dataClass: 'meeting-content',
    location: 'user-data',
    encryptedAtRest: 'always',
    scope: 'device',
    phase: 2,
    recreatedBy: ['import job finishing late'],
    names: ['import-jobs'],
    owner: 'import-job-store.ts',
    paths: ['import-jobs']
  }),
  row({
    id: 'dictation-memory',
    label: 'Dictation journal and personal dictionary',
    dataClass: 'dictation',
    location: 'user-data',
    encryptedAtRest: 'always',
    scope: 'owner-partition',
    exportable: true,
    phase: 2,
    recreatedBy: ['dictation recovery'],
    names: ['dictation-memory'],
    owner: 'lifecycle/dictation-memory-wiring.ts',
    paths: ['dictation-memory/journal'],
    partitionPaths: ['dictation-memory/dictionary/{pid}.dd1']
  }),
  row({
    id: 'brain',
    label: 'Knowledge store (brain) of this account',
    dataClass: 'derived-knowledge',
    location: 'partition',
    encryptedAtRest: 'setting',
    scope: 'owner-partition',
    exportable: true,
    phase: 3,
    recreatedBy: ['ingest of a late or synced-back meeting', 'corrections conflict copy', 'escrow restore']
  }),
  row({
    id: 'brain-backup',
    label: 'Knowledge store backup',
    dataClass: 'derived-knowledge',
    location: 'partition',
    encryptedAtRest: 'setting',
    scope: 'owner-partition',
    phase: 3,
    recreatedBy: ['backup restore on rebuild']
  }),
  row({
    id: 'brain-preserved',
    label: 'Preserved unreadable knowledge store and rebuild escrow',
    dataClass: 'derived-knowledge',
    location: 'partition',
    encryptedAtRest: 'setting',
    scope: 'owner-partition',
    phase: 3,
    recreatedBy: ['escrow restore']
  }),
  row({
    id: 'wiki',
    label: 'Published wiki pages',
    dataClass: 'derived-knowledge',
    location: 'meetings-folder',
    encryptedAtRest: 'never',
    scope: 'owner-partition',
    phase: 3,
    recreatedBy: ['brain publish']
  }),
  row({
    id: 'graph',
    label: 'Knowledge graph files',
    dataClass: 'derived-knowledge',
    location: 'user-data',
    encryptedAtRest: 'never',
    scope: 'device',
    phase: 3,
    recreatedBy: ['graph rebuild'],
    names: ['graph'],
    owner: 'graphify.ts',
    paths: ['graph']
  }),
  row({
    id: 'assistants',
    label: 'Your assistants',
    dataClass: 'assistant',
    location: 'user-data',
    encryptedAtRest: 'always',
    scope: 'owner-partition',
    exportable: true,
    phase: 3,
    recreatedBy: ['assistant store write'],
    names: ['assistants'],
    owner: 'lifecycle/assistants-wiring.ts',
    partitionPaths: ['assistants/{pid}.bin']
  }),
  row({
    id: 'user-memory',
    label: 'Preferences and project context Métis remembers',
    dataClass: 'memory',
    location: 'user-data',
    encryptedAtRest: 'always',
    scope: 'owner-partition',
    exportable: true,
    phase: 3,
    recreatedBy: ['user memory write'],
    names: ['user-memory'],
    owner: 'lifecycle/user-memory-wiring.ts',
    partitionPaths: ['user-memory/{pid}.um1']
  }),
  row({
    id: 'context-snapshots',
    label: 'Context snapshots',
    dataClass: 'cache',
    location: 'user-data',
    encryptedAtRest: 'always',
    scope: 'device',
    phase: 3,
    recreatedBy: ['context grant'],
    names: ['context-snapshots'],
    owner: 'features/context-grants/compose.ts',
    paths: ['context-snapshots']
  }),
  row({
    id: 'connector-accounts',
    label: 'Connected accounts',
    dataClass: 'connector',
    location: 'user-data',
    encryptedAtRest: 'always',
    scope: 'device',
    phase: 3,
    recreatedBy: ['connector sign-in'],
    names: ['connector-accounts'],
    owner: 'features/connectors/account-store.ts',
    paths: ['connector-accounts']
  }),
  row({
    id: 'desktop-tasks',
    label: 'Desktop action tasks',
    dataClass: 'task',
    location: 'user-data',
    encryptedAtRest: 'always',
    scope: 'device',
    phase: 3,
    recreatedBy: ['task recovery'],
    names: ['desktop-action-tasks.bin'],
    owner: 'tasks/desktop-action-task-runtime.ts',
    paths: ['desktop-action-tasks.bin']
  }),
  row({
    id: 'desktop-task-acks',
    label: 'Desktop action acknowledgements',
    dataClass: 'task',
    location: 'user-data',
    encryptedAtRest: 'never',
    scope: 'device',
    phase: 3,
    recreatedBy: ['task recovery'],
    names: ['desktop-action-acks.json'],
    owner: 'tasks/desktop-action-task-runtime.ts',
    paths: ['desktop-action-acks.json']
  }),
  row({
    id: 'voiceprints',
    label: 'Speaker voiceprints',
    dataClass: 'biometric',
    location: 'user-data',
    encryptedAtRest: 'always',
    scope: 'device',
    phase: 3,
    recreatedBy: ['speaker enrolment'],
    names: ['voiceprints.json'],
    owner: 'speaker-id.ts',
    paths: ['voiceprints.json']
  }),
  row({
    id: 'artifacts-registry',
    label: 'Files produced in answers (registry)',
    dataClass: 'cache',
    location: 'memory',
    encryptedAtRest: 'never',
    scope: 'owner-partition',
    phase: 3,
    recreatedBy: ['export and tool producers']
  }),
  row({
    id: 'task-browser-profile',
    label: 'Task browser profile',
    dataClass: 'cache',
    location: 'user-data',
    encryptedAtRest: 'never',
    scope: 'device',
    phase: 3,
    recreatedBy: ['task browser use']
  }),
  row({
    id: 'operator-outbox',
    label: 'Queued organisation reports',
    dataClass: 'outbox',
    location: 'user-data',
    encryptedAtRest: 'never',
    scope: 'device',
    phase: 1,
    recreatedBy: ['operator reporting'],
    names: ['operator-queue.json'],
    owner: 'operator-queue.ts'
  }),
  row({
    id: 'mcp-push-queue',
    label: 'Queued tool pushes',
    dataClass: 'outbox',
    location: 'user-data',
    encryptedAtRest: 'never',
    scope: 'device',
    phase: 1,
    recreatedBy: ['tool push'],
    names: ['mcp-push-queue.json'],
    owner: 'mcp/pushQueue.ts',
    paths: ['mcp-push-queue.json']
  }),
  row({
    id: 'history-cache',
    label: 'History list cache',
    dataClass: 'cache',
    location: 'memory',
    encryptedAtRest: 'never',
    scope: 'device',
    phase: 4,
    recreatedBy: ['history read']
  }),
  row({
    id: 'crash-logs',
    label: 'Crash logs',
    dataClass: 'log',
    location: 'user-data',
    encryptedAtRest: 'never',
    scope: 'device',
    phase: 4,
    recreatedBy: ['a crash'],
    names: ['crash-'],
    owner: 'index.ts'
  }),
  row({
    id: 'stall-bundles',
    label: 'Responsiveness stall bundles',
    dataClass: 'log',
    location: 'user-data',
    encryptedAtRest: 'never',
    scope: 'device',
    phase: 4,
    recreatedBy: ['a stall'],
    names: ['diagnostics'],
    owner: 'infra/observability/stall-bundle.ts',
    paths: ['diagnostics/stalls']
  }),
  row({
    id: 'responsiveness-report',
    label: 'Responsiveness report',
    dataClass: 'log',
    location: 'user-data',
    encryptedAtRest: 'never',
    scope: 'device',
    phase: 4,
    recreatedBy: ['responsiveness recorder'],
    names: ['responsiveness-report.json'],
    owner: 'infra/observability/responsiveness-recorder.ts',
    paths: ['logs/responsiveness-report.json']
  }),
  row({
    id: 'time-saved-log',
    label: 'Time-saved log',
    dataClass: 'log',
    location: 'user-data',
    encryptedAtRest: 'never',
    scope: 'device',
    phase: 4,
    recreatedBy: ['a finished meeting'],
    names: ['time-saved.jsonl'],
    owner: 'time-saved-log.ts',
    paths: ['time-saved.jsonl']
  }),
  row({
    id: 'export-receipts',
    label: 'Export receipts',
    dataClass: 'receipt',
    location: 'user-data',
    encryptedAtRest: 'never',
    scope: 'device',
    phase: 4,
    recreatedBy: ['an export'],
    names: ['export-receipts.jsonl'],
    owner: 'index.ts',
    paths: ['export-receipts.jsonl']
  }),
  row({
    id: 'main-log',
    label: 'Application log',
    dataClass: 'log',
    location: 'user-data',
    encryptedAtRest: 'never',
    scope: 'device',
    phase: 4,
    recreatedBy: ['normal operation'],
    names: ['main.log'],
    owner: 'logger.ts'
  }),
  row({
    id: 'credentials',
    label: 'Sign-in tokens and keys',
    dataClass: 'credential',
    location: 'user-data',
    encryptedAtRest: 'always',
    scope: 'device',
    phase: 5,
    recreatedBy: ['signing in']
  }),
  row({
    id: 'audit-log',
    label: 'Audit log (hash chain, no content)',
    dataClass: 'log',
    location: 'user-data',
    encryptedAtRest: 'never',
    scope: 'device',
    erase: 'retain',
    reason: 'audit-chain-integrity',
    names: ['audit.log'],
    owner: 'logger.ts'
  }),
  row({
    id: 'erasure-receipts',
    label: 'Erasure receipts',
    dataClass: 'receipt',
    location: 'user-data',
    encryptedAtRest: 'never',
    scope: 'device',
    erase: 'retain',
    reason: 'proof-of-erasure'
  }),
  row({
    id: 'identity',
    label: 'Account identity records (partition ledger, erasure fence)',
    dataClass: 'receipt',
    location: 'user-data',
    encryptedAtRest: 'never',
    scope: 'device',
    erase: 'retain',
    reason: 'recognise-owner-and-keep-fence',
    names: ['identity'],
    owner: 'memory-partition/partition-ledger.ts'
  }),
  row({
    id: 'settings',
    label: 'Settings',
    dataClass: 'receipt',
    location: 'user-data',
    encryptedAtRest: 'always',
    scope: 'device',
    erase: 'retain',
    reason: 'reset-is-profile-recovery'
  }),
  row({
    id: 'memory-server',
    label: 'Memory server residue',
    dataClass: 'remote',
    location: 'remote',
    encryptedAtRest: 'never',
    scope: 'remote-tenant',
    erase: 'external',
    reason: 'memory-server-owner-delete-missing'
  }),
  row({
    id: 'operator-records',
    label: 'Organisation (Operator) records',
    dataClass: 'remote',
    location: 'remote',
    encryptedAtRest: 'never',
    scope: 'remote-tenant',
    erase: 'external',
    reason: 'operator-endpoint-missing'
  }),
  row({
    id: 'cloud-sync-copies',
    label: 'Cloud-sync, other-device and recycle-bin copies',
    dataClass: 'remote',
    location: 'remote',
    encryptedAtRest: 'never',
    scope: 'remote-tenant',
    erase: 'external',
    reason: 'cloud-sync-recycle-bin'
  })
]

export const DATA_STORE_IDS: readonly DataStoreId[] = DATA_STORES.map((entry) => entry.id)

export function dataStoresFor(policy: DataErasePolicy): DataStoreEntry[] {
  return DATA_STORES.filter((entry) => entry.erase === policy)
}

/** The `delete` rows of one phase, in inventory order. */
export function erasablePhase(phase: ErasurePhase): DataStoreEntry[] {
  return DATA_STORES.filter((entry) => entry.erase === 'delete' && entry.phase === phase)
}
