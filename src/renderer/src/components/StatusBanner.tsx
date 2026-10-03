import { AlertTriangle, RefreshCw, Settings, ShieldPlus } from 'lucide-react'
import type { PublicSettings } from '@shared/ipc'

type SettingsHealth = PublicSettings['settingsHealth']['settingsJson']

function unreadableSettingsCopy(health: NonNullable<SettingsHealth>): string {
  if (health.recovered) {
    return 'Métis recovered settings from a backup, but the main settings file still needs repair.'
  }
  switch (health.reason) {
    case 'io':
      return "Métis can't read its settings file right now. Your saved settings were not overwritten."
    case 'legacy-keychain-unavailable':
      return "Métis can't unlock the old settings encryption on this device. Your saved settings were kept."
    case 'invalid-json':
      return "Métis found a damaged settings file. It kept a recovery copy and started with safe defaults."
    case 'undecryptable':
    case 'recovered':
      return "Métis can't decrypt its settings file on this device. Your saved settings were kept."
  }
}

export function StatusBanner({
  settings,
  onOpenSettings,
  onRetry,
  onRecoverProfile
}: {
  settings: PublicSettings | null
  onOpenSettings: () => void
  onRetry: () => void
  onRecoverProfile: () => void
}): JSX.Element | null {
  const health = settings?.settingsHealth?.settingsJson
  if (!health || health.status !== 'unreadable') return null
  return (
    <div
      role="status"
      className="fade-up flex flex-wrap items-center gap-2 rounded-xl border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/10 px-3 py-1.5 text-[11px] leading-snug text-[color:var(--color-warn)]"
    >
      <AlertTriangle size={13} className="shrink-0" aria-hidden="true" />
      <span className="min-w-[12rem] flex-1">{unreadableSettingsCopy(health)}</span>
      <button
        type="button"
        onClick={onRetry}
        className="no-drag focus-ring inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-medium hover:bg-[var(--color-warn)]/15"
      >
        <RefreshCw size={11} /> Retry
      </button>
      <button
        type="button"
        onClick={onOpenSettings}
        className="no-drag focus-ring inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-medium hover:bg-[var(--color-warn)]/15"
      >
        <Settings size={11} /> Data health
      </button>
      <button
        type="button"
        onClick={onRecoverProfile}
        className="no-drag focus-ring inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-medium hover:bg-[var(--color-warn)]/15"
      >
        <ShieldPlus size={11} /> New local profile
      </button>
    </div>
  )
}
