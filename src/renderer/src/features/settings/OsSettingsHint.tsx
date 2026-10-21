import type { SystemSettingsPane } from '@shared/contracts/settings-os-state'
import { isWindows } from '../../lib/keys'

/** One line under an OS-dependent toggle: why the OS refused, and the one action that fixes it. */
export function OsSettingsHint({
  id,
  text,
  pane
}: {
  id: string
  text: string
  pane: SystemSettingsPane
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-1 pb-1 text-[11px] leading-snug">
      <span id={id} className="text-[color:var(--cl-muted-foreground)]">
        {text}
      </span>
      <button
        type="button"
        onClick={() => void window.toto.openSystemSettings(pane).catch(() => undefined)}
        className="no-drag cl-focus text-[11px] font-medium text-[color:var(--cl-primary)] hover:underline"
      >
        {isWindows ? 'Open Settings' : 'Open System Settings'}
      </button>
    </div>
  )
}
