import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Check } from 'lucide-react'
import type { PlatformPermissions, ScreenCaptureCheckResult } from '@shared/ipc'
import { nextScreenCheckPass } from '@shared/screen-capture-check'
import { PermissionDot, ScreenPermissionRow } from '../../components/ScreenPermissionRow'
import { usePermissions } from '../../state'
import { isWindows } from '../../lib/keys'

/**
 * True exactly on the rising edge: screen recording just flipped to 'granted' after this component had
 * already observed it as something else. `prev === null` means "first observation since mount" and must
 * never count. On this exact edge, macOS's TCC grant exists but this already-running process's
 * ScreenCaptureKit session never saw it: it needs a relaunch, not another trip to System Settings.
 */
export function screenRecordingJustGranted(
  prev: PlatformPermissions['screenRecording'] | null,
  current: PlatformPermissions['screenRecording'],
  isWin: boolean
): boolean {
  return !isWin && prev !== null && prev !== 'granted' && current === 'granted'
}

export function PermissionsSection(): JSX.Element {
  const { permissions } = usePermissions()
  const isWin = window.navigator.platform.toLowerCase().includes('win')
  // A grant that flips to 'granted' WHILE this panel is open (not one already granted when it first
  // mounted) means this running process's ScreenCaptureKit session never saw it: macOS only applies a
  // fresh Screen Recording grant to the next launch. usePermissions already live-polls (state.ts,
  // PERMISSIONS_POLL_MS) so this only has to watch for the rising edge and offer the one-click fix
  // instead of the old dead end (a status dot that just quietly turns green with no capture that works).
  const prevScreenStatus = useRef<PlatformPermissions['screenRecording'] | null>(null)
  const [needsRestart, setNeedsRestart] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [lastCheckPass, setLastCheckPass] = useState<ScreenCaptureCheckResult['pass'] | null>(null)
  const [checkBusy, setCheckBusy] = useState(false)
  const [checkResult, setCheckResult] = useState<ScreenCaptureCheckResult | null>(null)

  useEffect(() => {
    if (!permissions) return
    if (screenRecordingJustGranted(prevScreenStatus.current, permissions.screenRecording, isWin)) {
      setNeedsRestart(true)
    }
    prevScreenStatus.current = permissions.screenRecording
  }, [permissions, isWin])

  const restart = (): void => {
    setRestarting(true)
    void window.toto.relaunch().catch(() => setRestarting(false))
  }

  const runScreenCheck = (): void => {
    if (checkBusy) return
    const pass = nextScreenCheckPass(lastCheckPass)
    setCheckBusy(true)
    void window.toto
      .screenCaptureCheck(pass)
      .then((result) => {
        setLastCheckPass(result.pass)
        setCheckResult(result)
      })
      .catch((err) => {
        setLastCheckPass(pass)
        setCheckResult({
          ok: false,
          pass,
          message: err instanceof Error ? err.message : 'Screen capture check failed.'
        })
      })
      .finally(() => setCheckBusy(false))
  }

  if (!permissions) {
    return <div className="text-[13px] text-[color:var(--cl-muted-foreground)]">Checking permissions…</div>
  }

  const rows: { label: string; status: string; note: string; kind: 'microphone' | 'screenRecording'; fixLabel?: string }[] = [
    {
      label: 'Microphone',
      status: permissions.microphone,
      kind: 'microphone',
      note: isWin
        ? 'Windows asks the first time you start Listen.'
        : 'Needed to hear your calls. Grant in System Settings → Privacy & Security → Microphone.',
      fixLabel: isWin ? 'Check Windows Settings' : undefined
    },
    {
      label: 'Screen / system audio',
      status: permissions.screenRecording,
      kind: 'screenRecording',
      note: isWin
        ? 'Windows may ask once before capturing system audio.'
        : "Needed so Métis can answer questions about your screen and capture system audio. Grant in System Settings → Privacy & Security → Screen Recording.",
      fixLabel: isWin ? 'Check Windows Settings' : undefined
    }
  ]

  return (
    <div className="flex flex-col gap-2">
      {rows.map((r) => {
        // Mirrors Onboarding's CheckRow: an explicit Deny (macOS) always gets a fix link; on Windows,
        // which never reports a true Deny, fixLabel unlocks the link instead so there's still a way back
        // to Settings for a not-yet-granted mic or a screen-capture prompt the user dismissed.
        const denied = r.status === 'denied'
        // macOS 'not-determined'/'unknown' used to render NO control at all — a user who skipped
        // onboarding had no in-app path to trigger the mic prompt or register Métis with TCC (Screen
        // Recording's pane doesn't even list an app until it has probed once). Requesting is safe:
        // askForMediaAccess never re-prompts after an explicit Deny, and the screen probe is a 1×1
        // registration capture.
        const notYetAsked = !isWin && (r.status === 'not-determined' || r.status === 'unknown')
        const showFix = denied || notYetAsked || (isWin && r.fixLabel)
        const showRestart = r.kind === 'screenRecording' && needsRestart
        // M2-0429: on macOS the raw status cannot tell "never asked" from "on in System Settings but held by
        // another build or copy"; the diagnosis can, and owns this row's copy and actions.
        const screenDiagnosis = r.kind === 'screenRecording' && !isWin ? permissions.screenDiagnosis : undefined
        if (screenDiagnosis) {
          return <ScreenPermissionRow key={r.label} status={r.status} diagnosis={screenDiagnosis} restarting={restarting} onRestart={restart} />
        }
        return (
          <div key={r.label} className="cl-card flex items-start gap-2 px-2.5 py-2">
            <PermissionDot status={r.status} />
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-medium text-[color:var(--cl-foreground)]">{r.label}</span>
                <span className="text-[11px] capitalize text-[color:var(--cl-muted-foreground)]">
                  {r.status.replace(/-/g, ' ')}
                </span>
              </div>
              <div className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">{r.note}</div>
              {showRestart ? (
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-[11px] leading-snug text-[color:var(--cl-primary)]">
                    Granted. Restart Métis to finish enabling it.
                  </span>
                  <button
                    type="button"
                    onClick={restart}
                    disabled={restarting}
                    className="no-drag cl-focus rounded-full bg-[var(--cl-primary)]/15 px-2.5 py-1 text-[11px] font-semibold text-[color:var(--cl-primary)] hover:bg-[var(--cl-primary)]/25 disabled:opacity-60"
                  >
                    {restarting ? 'Restarting…' : 'Restart Métis'}
                  </button>
                </div>
              ) : (
                showFix && (
                  <button
                    type="button"
                    onClick={() =>
                      void (notYetAsked
                        ? window.toto.requestPermissionsUpfront().catch(() => null)
                        : window.toto.openPermissionSettings(r.kind))
                    }
                    className="no-drag cl-focus mt-0.5 text-[11px] font-medium text-[color:var(--cl-primary)] hover:underline"
                  >
                    {notYetAsked
                      ? 'Request permission'
                      : (r.fixLabel ?? (isWindows ? 'Open Windows Settings' : 'Open System Settings'))}
                  </button>
                )
              )}
            </div>
          </div>
        )
      })}
      <div className="cl-card flex flex-col gap-1.5 px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13px] font-medium text-[color:var(--cl-foreground)]">Screen capture check</span>
          <button
            type="button"
            onClick={runScreenCheck}
            disabled={checkBusy}
            className="no-drag cl-focus rounded-full bg-[var(--cl-primary)]/15 px-2.5 py-1 text-[11px] font-semibold text-[color:var(--cl-primary)] hover:bg-[var(--cl-primary)]/25 disabled:opacity-60"
          >
            {checkBusy
              ? lastCheckPass == null
                ? 'Checking…'
                : 'Asking the model…'
              : lastCheckPass == null
                ? 'Check screen capture'
                : 'Check again with AI'}
          </button>
        </div>
        <div className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
          First check is the OS permission probe. Check again to send a frame to Local AI if it is ready,
          otherwise the active API (including Dust when that is the provider). The result stays here. It
          is never sent to a teammate.
        </div>
        {checkResult && (
          <div
            className={[
              'flex items-start gap-1.5 text-[12px]',
              checkResult.ok
                ? 'text-[color:var(--cl-success)]'
                : 'text-[color:var(--cl-destructive)]'
            ].join(' ')}
          >
            {checkResult.ok ? <Check size={13} className="mt-0.5 shrink-0" /> : <AlertCircle size={13} className="mt-0.5 shrink-0" />}
            <span>
              {checkResult.message}
              {checkResult.ok && checkResult.preview ? ` ${checkResult.preview}` : ''}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
