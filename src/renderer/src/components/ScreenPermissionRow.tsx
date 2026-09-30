/**
 * ScreenPermissionRow.tsx — Settings' permission status dot and its macOS "Meeting audio & screen" row, and
 * the Bar chip's Repair button (M2-0429).
 *
 * On macOS the raw status cannot tell "never asked" from "on in System Settings but held by another build or
 * copy"; the diagnosis can, so it owns this row's label, copy and actions. The not-effective state offers
 * Repair and lists the duplicate copies, never "open System Settings" alone.
 */
import { useState } from 'react'
import type { ScreenDiagnosis } from '@shared/screen-permission'
import {
  MEETING_AUDIO_SCREEN_LABEL,
  MEETING_AUDIO_SCREEN_WHY,
  runScreenRepair,
  screenPermissionCopy
} from '../lib/screen-permission-copy'

export function PermissionDot({ status }: { status: string }): JSX.Element {
  const color =
    status === 'granted'
      ? 'bg-[var(--cl-success)]'
      : status === 'denied'
        ? 'bg-[var(--cl-destructive)]'
        : 'bg-white/30'
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} aria-hidden="true" />
}

/** The Bar's "Mic only" chip, when the grant belongs to another build or copy (the tooltip names it): the
 *  switch in System Settings already shows on, so the one useful action is Repair. */
export function ScreenRepairButton(): JSX.Element {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        void runScreenRepair()
      }}
      className="no-drag focus-ring ml-1 rounded-full bg-white/10 px-1.5 text-[10px] font-semibold hover:bg-white/20"
    >
      Repair
    </button>
  )
}

/** Short status for the Settings row, from the diagnosis rather than the raw status. */
export function screenDiagnosisLabel(d: ScreenDiagnosis): string {
  switch (d.state) {
    case 'granted':
      return 'Granted'
    case 'not-asked':
      return 'Not asked yet'
    case 'denied':
      return 'Denied'
    case 'needs-relaunch':
      return 'Restart needed'
    case 'not-effective':
      return 'Not in effect'
    case 'restricted':
      return 'Managed by your organization'
  }
}

/** The diagnosis-driven copy and actions for the macOS Screen Recording row. */
function ScreenDiagnosisActions({
  diagnosis,
  restarting,
  onRestart
}: {
  diagnosis: ScreenDiagnosis
  restarting: boolean
  onRestart: () => void
}): JSX.Element | null {
  const [repairBusy, setRepairBusy] = useState(false)
  const [repairGuidance, setRepairGuidance] = useState<string | null>(null)
  const copy = screenPermissionCopy(diagnosis)
  if (!copy) return null
  const primary =
    'no-drag cl-focus rounded-full bg-[var(--cl-primary)]/15 px-2.5 py-1 text-[11px] font-semibold text-[color:var(--cl-primary)] hover:bg-[var(--cl-primary)]/25 disabled:opacity-60'
  const link = 'no-drag cl-focus text-[11px] font-medium text-[color:var(--cl-primary)] hover:underline'
  const repair = (): void => {
    setRepairBusy(true)
    void runScreenRepair().then((result) => {
      // Success relaunches the app from main; only a failure comes back here.
      if (!result.ok) setRepairGuidance(result.guidance || null)
      setRepairBusy(false)
    })
  }
  return (
    <div className="mt-1 flex flex-col gap-1">
      <div className="text-[11px] leading-snug text-[color:var(--cl-foreground)]">{repairGuidance ?? copy.text}</div>
      <div className="flex flex-wrap items-center gap-2">
        {copy.repair && !repairGuidance && (
          <button type="button" onClick={repair} disabled={repairBusy} className={primary}>
            {repairBusy ? 'Repairing…' : 'Repair'}
          </button>
        )}
        {diagnosis.action === 'request' && (
          <button type="button" onClick={() => void window.toto.requestPermissionsUpfront().catch(() => null)} className={primary}>
            Allow meeting audio & screen
          </button>
        )}
        {copy.relaunch && (
          <button type="button" onClick={onRestart} disabled={restarting} className={primary}>
            {restarting ? 'Restarting…' : 'Restart Métis'}
          </button>
        )}
        {(copy.openSettings || repairGuidance) && (
          <button type="button" onClick={() => void window.toto.openPermissionSettings('screenRecording')} className={link}>
            Open System Settings
          </button>
        )}
        {copy.attest && (
          <button type="button" onClick={() => void window.toto.attestScreenPermission().catch(() => {})} className={link}>
            It’s already on
          </button>
        )}
      </div>
      {diagnosis.duplicates.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {diagnosis.duplicates.map((copyOnDisk) => (
            <li key={copyOnDisk.path} className="flex items-center justify-between gap-2 text-[11px] text-[color:var(--cl-muted-foreground)]">
              <span className="min-w-0 truncate" title={copyOnDisk.path}>
                {copyOnDisk.path}
                {copyOnDisk.version ? ` (${copyOnDisk.version})` : ''}
              </span>
              <button type="button" onClick={() => void window.toto.revealAppCopy(copyOnDisk.path).catch(() => {})} className={link}>
                Show in Finder
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function ScreenPermissionRow({
  status,
  diagnosis,
  restarting,
  onRestart
}: {
  status: string
  diagnosis: ScreenDiagnosis
  restarting: boolean
  onRestart: () => void
}): JSX.Element {
  return (
    <div className="cl-card flex items-start gap-2 px-2.5 py-2">
      <PermissionDot status={status} />
      <div className="flex-1">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-medium text-[color:var(--cl-foreground)]">{MEETING_AUDIO_SCREEN_LABEL}</span>
          <span className="text-[11px] text-[color:var(--cl-muted-foreground)]">{screenDiagnosisLabel(diagnosis)}</span>
        </div>
        <div className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">{MEETING_AUDIO_SCREEN_WHY}</div>
        <ScreenDiagnosisActions diagnosis={diagnosis} restarting={restarting} onRestart={onRestart} />
      </div>
    </div>
  )
}
