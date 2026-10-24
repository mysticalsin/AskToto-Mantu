import { useEffect, useState, type ReactNode } from 'react'
import { AlertCircle, AudioLines, Info, Lock } from 'lucide-react'
import type { PublicSettings } from '@shared/ipc'
import { isCloudOnlyProfile, resolveEnterpriseLiveProfile } from '@shared/enterprise-live-profile'
import {
  DEFAULT_VOICE_ACTIONS_SETTINGS,
  VOICE_WAKE_WORD_GATE_PASSED,
  type VoiceActionsSettings
} from '@shared/voice-actions-settings'
import { latchDictationNote } from '@shared/voice/chord-recorder'
import type { VoiceStateSnapshot } from '@shared/voice/voice-turn'
import { usePermissions } from '../../state'
import { isWindows } from '../../lib/keys'
import { Section } from '../../ui/Section'
import { ToggleRow } from '../../ui/Toggle'
import { managedChipCls } from '../../ui/ManagedChip'
import { HoldChordRecorder } from './HoldChordRecorder'
import { PermissionRow } from './PermissionsSection'

const HINT = 'text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]'

/** What the person is told, in one place so Opus reviews the words together. */
export const VOICE_ACTIONS_COPY = {
  title: 'Voice actions',
  desc: 'Hold the shortcut and say what you want. Métis answers questions and can open apps, search the web and create notes. It asks before it creates or changes anything.',
  toggleLabel: 'Use voice actions',
  toggleDesc: 'Starts or stops listening for the shortcut. The change applies right away.',
  preview: 'Off until you turn it on. Hold to talk is still being tested on real keyboards.',
  managed: "Your organization sets this. You can't change it here.",
  cloudOnly: 'Your organization requires cloud speech. Voice actions use on-device speech.',
  stopped: 'The voice shortcut stopped working. Restart Métis.',
  unavailable: "Hold to talk isn't available on this computer yet.",
  latchLabel: 'Double press to keep listening',
  latchDesc: 'Press the shortcut twice quickly to listen hands-free, then press it once to stop.',
  wakeLabel: 'Listen for “Hey Métis”',
  wakeDescMac:
    'Keeps the microphone on to hear “Hey Métis”. Speech is processed on this Mac and never saved. Uses more battery.',
  wakeDescWin:
    'Keeps the microphone on to hear “Hey Métis”. Speech is processed on this computer and never saved. Uses more battery.',
  wakeUnavailable:
    'Not available yet. It needs an on-device listener that has passed Métis accuracy and battery checks.',
  micWhy: 'Voice actions listen only while you hold the shortcut. Métis needs your microphone to hear you.',
  conversationLabel: 'Enable continuous conversation',
  conversationDesc: 'Opt in to an ongoing voice conversation. Métis listens in short turns until you stop it.',
  conversationStart: 'Start conversation',
  conversationStartHint: 'Starting here opens the conversation. Microphone access is handled when capture begins.'
} as const

/** Voice actions state from main: the effective on/off (build default, QA, policy) and whether the shortcut runs. */
function useVoiceSnapshot(): VoiceStateSnapshot | null {
  const [snapshot, setSnapshot] = useState<VoiceStateSnapshot | null>(null)
  useEffect(() => {
    let cancelled = false
    let unsubscribe: (() => void) | null = null
    void (async () => {
      try {
        const bridge = window.toto.voiceActions
        unsubscribe = bridge.onState((next) => {
          if (!cancelled) setSnapshot(next)
        })
        const current = await bridge.getState()
        if (!cancelled && current)
          setSnapshot((previous) => (previous && previous.revision > current.revision ? previous : current))
      } catch {
        /* no bridge (a test host): the section still renders from settings */
      }
    })()
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])
  return snapshot
}

function Notice({ icon, children }: { icon: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <div className={`flex items-start gap-1.5 px-1 py-1 ${HINT}`}>
      <span className="mt-px shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  )
}

/**
 * Settings › Speech › Voice actions (V06). Every control applies at once (no Save, HIG S6). It never asks the
 * system for anything on its own: the microphone row appears only once voice actions are on and the OS has not
 * granted it, says why in one sentence, and raises the system prompt only from its Continue button.
 */
export function VoiceActionsSection({
  settings,
  patch,
  windows = isWindows
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => Promise<unknown> | void
  windows?: boolean
}): JSX.Element {
  const voice: VoiceActionsSettings = settings.voiceActions ?? DEFAULT_VOICE_ACTIONS_SETTINGS
  const snapshot = useVoiceSnapshot()
  const { permissions } = usePermissions()
  const platform = windows ? 'win32' : 'darwin'
  const chordKey = windows ? 'win' : 'mac'
  const chord = voice.holdChord[chordKey]
  const cloudOnly = isCloudOnlyProfile(resolveEnterpriseLiveProfile(settings.enterpriseLive))
  const managed = settings.managedKeys?.includes('voiceActions') === true
  const conversationEnabled = voice.conversation.enabled === true

  // `null` follows the build default (on in QA builds, off as a Preview in release builds); a boolean is a choice.
  const chosen = typeof voice.enabled === 'boolean'
  const on = !cloudOnly && (chosen ? voice.enabled === true : snapshot?.enabled === true)
  const canStartConversation = on && conversationEnabled && !managed && !cloudOnly
  const preview = !chosen && snapshot !== null && !snapshot.enabled && !cloudOnly
  const subDisabled = managed || !on
  const wakeOpen = VOICE_WAKE_WORD_GATE_PASSED

  const notifyRecorder = (active: boolean): void => {
    try {
      void Promise.resolve(window.toto.voiceActions.setChordRecorderActive(active)).catch(() => null)
    } catch {
      /* no bridge */
    }
  }
  const latchNote = latchDictationNote(chord, platform)
  const micStatus = permissions?.microphone
  const needsMic = on && (micStatus === 'denied' || micStatus === 'unknown')

  return (
    <Section title={VOICE_ACTIONS_COPY.title} desc={VOICE_ACTIONS_COPY.desc} icon={AudioLines}>
      <ToggleRow
        label={VOICE_ACTIONS_COPY.toggleLabel}
        desc={VOICE_ACTIONS_COPY.toggleDesc}
        on={on}
        onChange={(v) => void patch({ voiceActions: { ...voice, enabled: v } })}
        disabled={settings.managedKeys.includes('voiceActions') || cloudOnly}
        managedChip={managed}
      >
        {preview && (
          <div className={`mt-1 flex flex-wrap items-center gap-2 ${HINT}`}>
            <span className={managedChipCls}>Preview</span>
            <span>{VOICE_ACTIONS_COPY.preview}</span>
          </div>
        )}
      </ToggleRow>
      {managed && <Notice icon={<Lock size={12} aria-hidden />}>{VOICE_ACTIONS_COPY.managed}</Notice>}
      {cloudOnly && <Notice icon={<Info size={12} aria-hidden />}>{VOICE_ACTIONS_COPY.cloudOnly}</Notice>}
      <div className="mt-1 flex flex-col gap-1 border-t border-[var(--cl-border)] pt-2 pl-3">
        <ToggleRow
          label={VOICE_ACTIONS_COPY.conversationLabel}
          desc={VOICE_ACTIONS_COPY.conversationDesc}
          on={conversationEnabled}
          onChange={(enabled) =>
            void patch({ voiceActions: { ...voice, conversation: { ...voice.conversation, enabled } } })
          }
          disabled={!on || settings.managedKeys.includes('voiceActions') || cloudOnly}
          managedChip={managed}
        />
        <button
          type="button"
          data-metis-conversation-start
          disabled={!canStartConversation}
          onClick={() => void window.toto.conversation.start().catch(() => null)}
          className="no-drag cl-focus w-fit rounded-md border border-[var(--cl-border)] px-2.5 py-1.5 text-xs font-medium text-[color:var(--cl-foreground)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {VOICE_ACTIONS_COPY.conversationStart}
        </button>
        <div className={HINT}>{VOICE_ACTIONS_COPY.conversationStartHint}</div>
      </div>
      {on && snapshot?.shortcut === 'stopped' && (
        <Notice icon={<AlertCircle size={12} aria-hidden />}>
          {VOICE_ACTIONS_COPY.stopped}{' '}
          <button
            type="button"
            onClick={() => void window.toto.relaunch().catch(() => null)}
            className="no-drag cl-focus font-medium text-[color:var(--cl-primary)] hover:underline"
          >
            Restart
          </button>
        </Notice>
      )}
      {on && snapshot?.shortcut === 'unavailable' && (
        <Notice icon={<Info size={12} aria-hidden />}>{VOICE_ACTIONS_COPY.unavailable}</Notice>
      )}

      <div
        className={[
          'mt-1 flex flex-col border-t border-[var(--cl-border)] pt-1 pl-3 transition-opacity',
          subDisabled ? 'opacity-60' : ''
        ].join(' ')}
        data-voice-sub-rows={subDisabled ? 'disabled' : 'enabled'}
      >
        <HoldChordRecorder
          tokens={chord}
          defaultTokens={DEFAULT_VOICE_ACTIONS_SETTINGS.holdChord[chordKey]}
          platform={platform}
          disabled={subDisabled}
          onCommit={(tokens) =>
            void patch({ voiceActions: { ...voice, holdChord: { ...voice.holdChord, [chordKey]: tokens } } })
          }
          onRecordingChange={notifyRecorder}
        />
        <ToggleRow
          label={VOICE_ACTIONS_COPY.latchLabel}
          desc={VOICE_ACTIONS_COPY.latchDesc}
          on={voice.doublePressLatch}
          onChange={(v) => void patch({ voiceActions: { ...voice, doublePressLatch: v } })}
          disabled={settings.managedKeys.includes('voiceActions') || !on}
          managedChip={false}
        >
          {latchNote && <div className={`mt-0.5 ${HINT}`}>{latchNote}</div>}
        </ToggleRow>
        <ToggleRow
          label={VOICE_ACTIONS_COPY.wakeLabel}
          desc={windows ? VOICE_ACTIONS_COPY.wakeDescWin : VOICE_ACTIONS_COPY.wakeDescMac}
          on={wakeOpen && voice.wakeWord}
          onChange={(v) => void patch({ voiceActions: { ...voice, wakeWord: v } })}
          disabled={settings.managedKeys.includes('voiceActions') || !on || !wakeOpen}
          managedChip={false}
        >
          {!wakeOpen && <div className={`mt-0.5 ${HINT}`}>{VOICE_ACTIONS_COPY.wakeUnavailable}</div>}
        </ToggleRow>
      </div>

      {needsMic && permissions && (
        <div className="mt-2">
          <PermissionRow
            kind="microphone"
            label="Microphone"
            status={permissions.microphone}
            windows={windows}
            why={VOICE_ACTIONS_COPY.micWhy}
          />
        </div>
      )}
    </Section>
  )
}
