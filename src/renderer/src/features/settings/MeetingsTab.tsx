import { useId, useState } from 'react'
import { AlertCircle, Check, CircleCheck, FolderCog, FolderOpen, X } from 'lucide-react'
import type { MeetingsFolderPickResult, TeamFolderRefusal } from '@shared/contracts/settings-os-state'
import type { PublicSettings } from '@shared/ipc'
import { isWindows } from '../../lib/keys'
import { unreportedPatch } from '../../lib/report-settings-patch'
import { ManagedChip } from '../../ui/ManagedChip'
import { Section } from '../../ui/Section'
import { ToggleRow } from '../../ui/Toggle'
import { DangerZoneSection } from './DangerZoneSection'
import { loginItemView, useSettingsOsState } from './os-state'
import { OsSettingsHint } from './OsSettingsHint'

/** Inline reason for a refused meetings-folder choice; null when nothing needs saying (saved or cancelled). */
export function meetingsFolderPickError(result: MeetingsFolderPickResult): string | null {
  if (result.ok || result.reason === 'cancelled') return null
  if (result.reason === 'not-writable') {
    return "Métis can't save meetings in that folder. Choose a folder you can write to. The current folder is unchanged."
  }
  return 'Sign in with your Mantu account first.'
}

/** Inline reason a picked team folder was refused; null for a settings snapshot (added, cancelled, signed out). */
export function teamFolderAddError(result: PublicSettings | TeamFolderRefusal): string | null {
  return 'ok' in result && result.ok === false ? result.message : null
}

export const FOLDER_CHANGED_NOTE =
  'Meetings already in the previous folder stay there. Métis now saves, lists and cleans up only this folder.'

/** Settings → Meetings: where meetings are saved, team transcript folders, encryption, login item, retention. */
export function MeetingsTab({
  settings,
  patch
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => Promise<PublicSettings>
}): JSX.Element {
  // openMeetingsFolder resolves a non-empty string on failure (e.g. the folder was deleted/unmounted) —
  // surface it instead of silently discarding it (was `void window.toto.openMeetingsFolder()`).
  const [meetingsFolderErr, setMeetingsFolderErr] = useState<string | null>(null)
  // HIG (Settings): a refused folder is explained next to its control and the last valid folder stays.
  const [folderPickErr, setFolderPickErr] = useState<string | null>(null)
  const [teamFolderErr, setTeamFolderErr] = useState<string | null>(null)
  const teamFolderErrId = useId()
  // After a successful change: old meetings are not moved, listed or cleaned up any more (multi-folder
  // management is a later release), so say so instead of leaving it to be discovered.
  const [folderChangedNote, setFolderChangedNote] = useState(false)
  const folderErrId = useId()
  const loginHintId = useId()
  // `patch({})` re-reads the settings snapshot after main changed a folder. It is a refresh, not a save, so it
  // goes around the reporting wrapper: its failure is not "couldn't save this change".
  const refreshSettings = (): void => void unreportedPatch(patch)({}).catch(() => undefined)
  const { osState, refreshOsState } = useSettingsOsState()
  const loginItem = loginItemView(settings.launchAtLogin, settings.loginItemOpenAtLogin, osState?.loginItem)
  return (
    <>
      <Section
        title="Meetings & transcripts"
        desc="Meetings are saved here as notes your Dust agents can read."
        icon={FolderOpen}
      >
        <div className="cl-card px-3 py-2.5">
          <div className="flex items-center gap-2">
            <FolderOpen size={15} className="shrink-0 text-[color:var(--cl-primary)]" />
            <span
              className="min-w-0 flex-1 truncate text-[12px] text-[color:var(--cl-foreground)]"
              title={settings.resolvedMeetingsFolder}
            >
              {settings.resolvedMeetingsFolder}
            </span>
            <ManagedChip keys={settings.managedKeys} k="meetingsFolder" />
          </div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={settings.managedKeys.includes('meetingsFolder')}
              aria-describedby={folderPickErr ? folderErrId : undefined}
              onClick={async () => {
                const result = await window.toto.pickFolder().catch(() => null)
                setFolderPickErr(
                  result ? meetingsFolderPickError(result) : "Métis couldn't change the folder. Try again."
                )
                setFolderChangedNote(result?.ok === true)
                // A refresh only: a failure here is not the folder choice failing, and must not go unhandled.
                refreshSettings()
              }}
              className={[
                'no-drag cl-focus flex items-center gap-1 rounded-lg bg-white/[0.05] px-2.5 py-1.5 text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.1]',
                settings.managedKeys.includes('meetingsFolder') ? 'opacity-60 cursor-not-allowed' : ''
              ].join(' ')}
            >
              <FolderCog size={12} /> Change folder
            </button>
            <button
              type="button"
              disabled={settings.managedKeys.includes('meetingsFolder')}
              onClick={async () => {
                const result = await window.toto.openMeetingsFolder()
                setMeetingsFolderErr(result || null)
              }}
              className={[
                'no-drag cl-focus flex items-center gap-1 rounded-lg bg-white/[0.05] px-2.5 py-1.5 text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.1]',
                settings.managedKeys.includes('meetingsFolder') ? 'opacity-60 cursor-not-allowed' : ''
              ].join(' ')}
            >
              <FolderOpen size={12} /> Open
            </button>
          </div>
          {folderPickErr && (
            <div
              id={folderErrId}
              role="alert"
              className="mt-1.5 flex items-center gap-1.5 text-[11px] text-[color:var(--cl-destructive)]"
            >
              <AlertCircle size={12} className="shrink-0" aria-hidden="true" /> {folderPickErr}
            </div>
          )}
          {folderChangedNote && !folderPickErr && (
            <div className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
              <CircleCheck size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
              {FOLDER_CHANGED_NOTE}
            </div>
          )}
          {meetingsFolderErr && (
            <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-[color:var(--cl-destructive)]">
              <AlertCircle size={12} className="shrink-0" /> {meetingsFolderErr}
            </div>
          )}
        </div>
        {/* Team transcripts — shared folders whose meetings are ALSO ingested into this brain,
                    attributed by folder name (settings.teamTranscriptFolders). Centralizes the team's calls
                    without touching where the user's OWN meetings are saved. */}
        <div className="cl-card mt-2 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <FolderOpen size={15} className="shrink-0 text-[color:var(--cl-primary)]" />
            <span className="min-w-0 flex-1 text-[12px] text-[color:var(--cl-foreground)]">Team transcripts</span>
            <ManagedChip keys={settings.managedKeys} k="teamTranscriptFolders" />
          </div>
          <p className="mt-1 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
            Shared folders whose meeting transcripts also feed this brain, attributed by folder name. Point one at a
            teammate&apos;s synced meetings folder to centralize the team&apos;s calls automatically.
          </p>
          {(settings.teamTranscriptFolders ?? []).length > 0 && (
            <div className="mt-2 flex flex-col gap-1">
              {(settings.teamTranscriptFolders ?? []).map((folder) => (
                <div key={folder} className="flex items-center gap-2 rounded-lg bg-white/[0.04] px-2 py-1.5">
                  <FolderOpen size={12} className="shrink-0 text-[color:var(--cl-muted-foreground)]" />
                  <span
                    className="min-w-0 flex-1 truncate text-[12px] text-[color:var(--cl-foreground)]"
                    title={folder}
                  >
                    {folder}
                  </span>
                  <button
                    type="button"
                    disabled={settings.managedKeys.includes('teamTranscriptFolders')}
                    onClick={async () => {
                      await window.toto.removeTeamTranscriptFolder(folder)
                      refreshSettings()
                    }}
                    title="Stop ingesting this folder"
                    aria-label={`Stop ingesting ${folder}`}
                    className="no-drag cl-focus rounded-md p-1 text-[color:var(--cl-muted-foreground)] hover:bg-white/[0.08] hover:text-[color:var(--cl-foreground)] disabled:opacity-60"
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="mt-2">
            <button
              type="button"
              disabled={settings.managedKeys.includes('teamTranscriptFolders')}
              aria-describedby={teamFolderErr ? teamFolderErrId : undefined}
              onClick={async () => {
                setTeamFolderErr(teamFolderAddError(await window.toto.addTeamTranscriptFolder()))
                refreshSettings()
              }}
              className={[
                'no-drag cl-focus flex items-center gap-1 rounded-lg bg-white/[0.05] px-2.5 py-1.5 text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.1]',
                settings.managedKeys.includes('teamTranscriptFolders') ? 'opacity-60 cursor-not-allowed' : ''
              ].join(' ')}
            >
              <FolderCog size={12} /> Add shared folder
            </button>
            {teamFolderErr && (
              <div
                id={teamFolderErrId}
                role="alert"
                className="mt-1.5 flex items-center gap-1.5 text-[11px] text-[color:var(--cl-destructive)]"
              >
                <AlertCircle size={12} className="shrink-0" aria-hidden="true" /> {teamFolderErr}
              </div>
            )}
          </div>
        </div>
        <div className="mt-2">
          <div className="rounded-lg bg-white/[0.03] px-3 py-2">
            <div className="flex items-center gap-2 text-[13px] font-medium text-[color:var(--cl-foreground)]">
              <Check size={14} className="text-[var(--color-accent-text)]" />
              Meetings are always saved
            </div>
            <div className="mt-0.5 text-[12px] leading-snug text-[color:var(--cl-muted-foreground)]">
              Every meeting&rsquo;s transcript and notes are written to the folder above when it ends. Remove any you
              don&rsquo;t want from History.
            </div>
          </div>
          {!settings.encryptTranscripts && (
            <div className="mt-1 flex items-start gap-1.5 px-1 text-[11px] leading-snug text-[color:var(--cl-destructive)]">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              Transcripts are saved as plain text in your chosen folder. If that folder syncs to the cloud, your data
              leaves this device.
            </div>
          )}
          <ToggleRow
            label="Encrypt transcripts at rest"
            desc={`Locks saved transcripts/notes with ${isWindows ? 'the Windows credential store' : 'your macOS Keychain'} so they're unreadable on disk. On by default. Métis's own History, search, and follow-up drafting still work normally; only a separate tool reading the raw files directly (outside Métis) would be blocked.`}
            on={settings.encryptTranscripts}
            onChange={(v) => patch({ encryptTranscripts: v })}
            disabled={settings.managedKeys.includes('encryptTranscripts')}
          >
            {settings.encryptTranscripts && (
              <div className="mt-1 flex items-start gap-1.5 px-1 text-[11px] leading-snug text-[color:var(--cl-success)]">
                <CircleCheck size={12} className="mt-0.5 shrink-0" />
                New meetings are encrypted at rest. Meetings saved before you turned this on stay as they were.
              </div>
            )}
          </ToggleRow>
          {/* Shows what the OS will do at login, not only the saved wish (HIG); re-read after every change. */}
          <ToggleRow
            label="Launch at login"
            desc="Open Métis automatically when you sign in."
            on={loginItem.on}
            // The refresh runs whether or not the write went through; a rejection is the reporting patch's to
            // announce, and is swallowed here so this derived promise does not surface it a second time.
            onChange={(v) =>
              void patch({ launchAtLogin: v })
                .catch(() => undefined)
                .finally(() => void refreshOsState())
            }
            disabled={settings.managedKeys.includes('launchAtLogin')}
            describedBy={loginItem.hint ? loginHintId : undefined}
          />
          {loginItem.hint && <OsSettingsHint id={loginHintId} text={loginItem.hint} pane="loginItems" />}
        </div>
      </Section>
      <DangerZoneSection settings={settings} patch={patch} />
    </>
  )
}
