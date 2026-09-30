export const managedChipCls =
  'inline-flex items-center gap-1 rounded-full border border-[var(--cl-primary)]/30 bg-[var(--cl-primary-soft)] px-1.5 py-0 text-[10px] font-medium text-[color:var(--cl-primary)]'

export function ManagedChip({ keys, k }: { keys: string[]; k: string }): JSX.Element | null {
  return keys.includes(k) ? <span className={managedChipCls}>Managed by your organization</span> : null
}
