import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Check } from 'lucide-react'
import type { PlatformPermissions, ScreenCaptureCheckResult } from '@shared/ipc'
import { nextScreenCheckPass } from '@shared/screen-capture-check'
import { PermissionDot, ScreenPermissionRow } from '../../components/ScreenPermissionRow'
import { usePermissions } from '../../state'
import { isWindows } from '../../lib/keys'
import { RELAUNCH_TITLE, openSettingsTitle, osSettingsWhere } from '../../lib/os-settings-copy'

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

type PermissionKind = 'microphone' | 'screenRecording'

const ROW_BUTTON =
  'no-drag cl-focus rounded-full bg-[var(--cl-primary)]/15 px-2.5 py-1 text-[11px] font-semibold text-[color:var(--cl-primary)] hover:bg-[var(--cl-primary)]/25 disabled:opacity-60'

/** Why each permission is needed, the same words on both platforms. */
const WHY: Record<PermissionKind, string> = {
  microphone: 'Needed to hear your side of calls.',
  screenRecording: 'Needed to answer questions about your screen and to hear the other side of calls.'
}

/**
 * One permission row (C32, Apple HIG Privacy). Not asked yet (macOS): one "Continue" that raises only this
 * row's system prompt. Denied: where to click, and one action that opens the exact privacy pane, titled for the
 * platform. Granted (or Windows with nothing refused): no action. Status re-checks when Métis becomes active
 * again (usePermissions), so a switch flipped in the OS pane shows here without a relaunch.
 */
export function PermissionRow({
  kind,
  label,
  status,
  windows,
  relaunch,
  why
}: {
  kind: PermissionKind
  label: string
  status: string
  windows: boolean
  /** The one sentence that says why this row asks, when the feature that shows it has its own reason. */
  why?: string
  /** Set when the grant only applies after a relaunch (macOS Screen Recording without a diagnosis). */
  relaunch?: { busy: boolean; run: () => void } | null
}): JSX.Element {
  const denied = status === 'denied'
  // macOS only: Windows raises no prompt for a desktop app, so there is nothing to ask there.
  const notYetAsked = !windows && (status === 'not-determined' || status === 'unknown')
  return (
    <div className="cl-card flex items-start gap-2 px-2.5 py-2" data-permission-row={kind}>
      <PermissionDot status={status} />
      <div className="flex-1">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-medium text-[color:var(--cl-foreground)]">{label}</span>
          <span className="text-[11px] capitalize text-[color:var(--cl-muted-foreground)]">
            {status.replace(/-/g, ' ')}
          </span>
        </div>
        <div className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
          {why ?? WHY[kind]}
          {denied ? ` ${osSettingsWhere(kind, windows)}` : ''}
        </div>
        {relaunch ? (
          <div className="mt-1 flex items-center gap-2">
            <span className="text-[11px] leading-snug text-[color:var(--cl-primary)]">
              Granted. macOS turns it on when Métis relaunches.
            </span>
            <button type="button" onClick={relaunch.run} disabled={relaunch.busy} className={ROW_BUTTON}>
              {relaunch.busy ? 'Relaunching…' : RELAUNCH_TITLE}
            </button>
          </div>
        ) : notYetAsked ? (
          <button
            type="button"
            // HIG P3 pre-alert: one button, titled Continue: the microphone's own system prompt, or for Screen
            // Recording (no prompt can say yes) the pane plus the guided helper.
            onClick={() =>
              void (
                kind === 'screenRecording'
                  ? window.toto.openPermissionHelper(kind)
                  : window.toto.requestPermissionsUpfront(kind)
              ).catch(() => null)
            }
            className={`${ROW_BUTTON} mt-1`}
          >
            Continue
          </button>
        ) : (
          denied && (
            <button
              type="button"
              onClick={() => void window.toto.openPermissionHelper(kind)}
              className="no-drag cl-focus mt-0.5 text-[11px] font-medium text-[color:var(--cl-primary)] hover:underline"
            >
              {openSettingsTitle(windows)}
            </button>
          )
        )}
      </div>
    </div>
  )
}

export function PermissionsSection({ windows = isWindows }: { windows?: boolean } = {}): JSX.Element {
  const { permissions } = usePermissions()
  const isWin = windows
  // A grant that flips to 'granted' WHILE this panel is open (not one already granted when it first
  // mounted) means this running process's ScreenCaptureKit session never saw it: macOS only applies a
  // fresh Screen Recording grant to the next launch. usePermissions already live-polls (state.ts,
  // PERMISSIONS_POLL_MS) and re-checks on focus, so this only has to watch for the rising edge and offer the
  // one-click Relaunch instead of a status dot that quietly turns green with no capture that works.
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
  // M2-0429: on macOS the raw status cannot tell "never asked" from "on in System Settings but held by another
  // build or copy"; the diagnosis can, and owns the screen row's copy and actions.
  const screenDiagnosis = isWin ? undefined : permissions.screenDiagnosis

  return (
    <div className="flex flex-col gap-2">
      <PermissionRow kind="microphone" label="Microphone" status={permissions.microphone} windows={isWin} />
      {screenDiagnosis ? (
        <ScreenPermissionRow
          status={permissions.screenRecording}
          diagnosis={screenDiagnosis}
          restarting={restarting}
          onRestart={restart}
        />
      ) : (
        <PermissionRow
          kind="screenRecording"
          label="Screen / system audio"
          status={permissions.screenRecording}
          windows={isWin}
          relaunch={needsRestart ? { busy: restarting, run: restart } : null}
        />
      )}
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
          First check is the OS permission probe. Check again to send a frame to Local AI if it is ready, otherwise the
          active API (including Dust when that is the provider). The result stays here. It is never sent to a teammate.
        </div>
        {checkResult && (
          <div
            className={[
              'flex items-start gap-1.5 text-[12px]',
              checkResult.ok ? 'text-[color:var(--cl-success)]' : 'text-[color:var(--cl-destructive)]'
            ].join(' ')}
          >
            {checkResult.ok ? (
              <Check size={13} className="mt-0.5 shrink-0" />
            ) : (
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
            )}
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
