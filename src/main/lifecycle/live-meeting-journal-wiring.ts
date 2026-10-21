import type { IpcMain } from 'electron'
import { isSummaryOnlyProfile, resolveEnterpriseLiveProfile } from '@shared/enterprise-live-profile'
import type { OwnerSessionRef, OwnerSessionRevokeReason } from '@shared/contracts/owner-session'
import {
  createLiveMeetingJournal,
  type LiveJournalAuditRecord,
  type LiveJournalKeyCustody,
  type LiveMeetingJournal
} from '../features/meetings/live-meeting-journal'
import { getMeetingSpeechLimits } from '../features/meetings/meeting-speech'
import type { TranscriptRevisionStore } from '../features/meetings/transcript-revision-store'
import {
  generateContentKey,
  readWrappedKeyFile,
  unwrapContentKey,
  wrapContentKey,
  writeWrappedKeyFile
} from '../infra/security/content-key-wrap'
import { registerMeetingJournalIpc } from '../ipc/meeting-journal-ipc'
import type { AuthorizeSender } from '../ipc/sender-auth'
import type { SettingsObservation } from '../settings-observation'

export interface LiveMeetingJournalWiringDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  authorizeSender: AuthorizeSender
  requireAuth(): boolean
  store: Pick<TranscriptRevisionStore, 'bindingOf'>
  ownerSession: { onRevoked(cb: (ref: OwnerSessionRef, reason: OwnerSessionRevokeReason) => void): () => void }
  /** Fires synchronously when a meeting's draft is finalized (saved, kept or discarded): the meeting is over. */
  onMeetingEnd(listener: (startedAt: number) => void): () => void
  readSettings(): SettingsObservation | null
  userDataPath(): string
  authGeneration(): number
  audit(event: 'meeting.journal.degraded', record: LiveJournalAuditRecord): void
  onWillQuit(listener: () => void): void
  /** Defaults to the real wrap/unwrap in `content-key-wrap.ts`; a test seam. */
  keys?: LiveJournalKeyCustody
  policyInstalled?(): boolean
}

/**
 * Whether the journal may touch disk right now: the `liveMeetingJournal` Settings switch (default on, managed policy
 * already merged into the published value) must not be off, the settings must be readable, the meeting must not be
 * a summary-only profile (no transcript is kept at all), and the trusted speech policy must be installed. An absent or
 * unreadable settings snapshot fails closed.
 */
export function liveMeetingJournalAllowed(published: SettingsObservation | null, policyInstalled: boolean): boolean {
  if (!policyInstalled || !published || !published.readable) return false
  const settings = published.settings
  if (settings.liveMeetingJournal === false) return false
  return !isSummaryOnlyProfile(resolveEnterpriseLiveProfile(settings.enterpriseLive ?? settings))
}

const DEFAULT_KEYS: LiveJournalKeyCustody = {
  generate: generateContentKey,
  wrap: wrapContentKey,
  unwrap: (wrapped) => unwrapContentKey(wrapped),
  writeFile: writeWrappedKeyFile,
  readFile: readWrappedKeyFile
}

/**
 * Builds the live meeting journal, registers its write seam, and ends its sessions on meeting end, owner-session
 * revocation and will-quit. Hangs off `createOwnerSessionWiring` so index.ts gains no lines.
 */
export function bootstrapLiveMeetingJournal(deps: LiveMeetingJournalWiringDeps): LiveMeetingJournal {
  const policyInstalled = deps.policyInstalled ?? ((): boolean => getMeetingSpeechLimits() !== undefined)
  const journal = createLiveMeetingJournal({
    userDataPath: deps.userDataPath,
    enabled: () => liveMeetingJournalAllowed(deps.readSettings(), policyInstalled()),
    bindingOf: (startedAt) => deps.store.bindingOf(startedAt),
    authGeneration: deps.authGeneration,
    keys: deps.keys ?? DEFAULT_KEYS,
    audit: deps.audit
  })
  registerMeetingJournalIpc({
    ipcMain: deps.ipcMain,
    authorizeSender: deps.authorizeSender,
    requireAuth: deps.requireAuth,
    journal
  })
  // The disposers are discarded on purpose: these bindings live for the app lifetime.
  deps.onMeetingEnd((startedAt) => {
    void journal.close(startedAt).catch(() => undefined)
  })
  deps.ownerSession.onRevoked((ref) => {
    void journal.closeOwnedBy(ref.ownerKey).catch(() => undefined)
  })
  deps.onWillQuit(() => {
    void journal.dispose().catch(() => undefined)
  })
  return journal
}
