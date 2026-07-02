interface Props {
  note: string
  compact?: boolean
}

export function PlaceholderBanner({ note, compact }: Props) {
  return (
    <div
      className={`flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 text-amber-300 ${
        compact ? 'px-3 py-1.5 text-[11px]' : 'px-4 py-2 text-xs'
      }`}
      role="status"
    >
      <span aria-hidden="true">⚠</span>
      <span className="font-semibold uppercase tracking-wide">Placeholder data</span>
      <span className="truncate opacity-80">{note}</span>
    </div>
  )
}
