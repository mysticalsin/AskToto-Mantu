import type { PublicSettings } from '@shared/ipc'
import { PROVIDERS } from '@shared/providers'

/**
 * Wave 2 — one-shot failover chip (docs/PROVIDER-ROUTING-POLICY.md). Distinct from the standing dead-key
 * banner: this is an EVENT (primary hopped once), dismissible, and clears via dismissFailoverNotice so it
 * never nags every poll. `onHide` records the hop's `at` locally the instant the user dismisses, because
 * refresh() can race a concurrent focus poll and re-show the same hop from a stale getSettings snapshot.
 */
export function FailoverChip({
  hop,
  onHide,
  refresh
}: {
  hop: NonNullable<PublicSettings['lastFailover']>
  onHide: (at: number) => void
  refresh: () => Promise<void>
}): JSX.Element {
  const fromLabel = PROVIDERS[hop.from as keyof typeof PROVIDERS]?.label ?? hop.from
  const toLabel = PROVIDERS[hop.to as keyof typeof PROVIDERS]?.label ?? hop.to
  return (
    <button
      type="button"
      onClick={() => {
        onHide(hop.at)
        void window.toto
          .dismissFailoverNotice()
          .then(() => refresh())
          .catch(() => {})
      }}
      className="no-drag focus-ring fade-up flex items-center justify-center gap-1.5 whitespace-nowrap rounded-xl border border-white/15 bg-white/[0.06] px-3 py-1.5 text-[11px] font-medium text-[color:var(--color-ink-2)]"
    >
      Switched from {fromLabel} to {toLabel}
      {hop.reason === 'exhausted' ? ' (quota)' : ''}. Tap to dismiss.
    </button>
  )
}
