import { ShieldCheck, Lightbulb, MessageSquareQuote, AlignLeft } from 'lucide-react'

export type QuickKind = 'factcheck' | 'whatnext' | 'explain' | 'summarize'

const ACTIONS: { kind: QuickKind; label: string; icon: typeof ShieldCheck }[] = [
  { kind: 'whatnext', label: 'What to say next', icon: MessageSquareQuote },
  { kind: 'factcheck', label: 'Fact-check', icon: ShieldCheck },
  { kind: 'explain', label: 'Explain', icon: Lightbulb },
  { kind: 'summarize', label: 'Summarize screen', icon: AlignLeft }
]

export function QuickActions({
  onAction,
  hint
}: {
  onAction: (k: QuickKind) => void
  hint: string
}): JSX.Element {
  return (
    <div className="fade-up flex flex-col items-center gap-1.5 px-1">
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        {ACTIONS.map((a) => (
          <button
            key={a.kind}
            type="button"
            onClick={() => onAction(a.kind)}
            className="no-drag focus-ring glass-chip flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium text-[color:var(--color-ink-2)] transition-colors duration-[var(--duration-hover)] hover:text-[color:var(--color-ink)]"
          >
            <a.icon size={13} className="text-[var(--color-accent)]" />
            {a.label}
          </button>
        ))}
      </div>
      <span className="text-[11px] text-[color:var(--color-ink-3)]">{hint}</span>
    </div>
  )
}
