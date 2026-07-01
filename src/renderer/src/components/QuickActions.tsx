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
  hint,
  rainbowRing
}: {
  onAction: (k: QuickKind) => void
  hint: string
  rainbowRing: boolean
}): JSX.Element {
  return (
    // mt-1.5: a touch more breathing room under the bar — its --shadow-bar reaches well past its own
    // bottom edge, and the parent's 8px flex gap alone wasn't enough to keep that fade from visibly
    // touching this row's pills (read as a grey halo over a light background, even with the pills' own
    // shadow removed below).
    <div className="fade-up mt-1.5 flex flex-col items-center gap-1.5 px-1">
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        {ACTIONS.map((a) => (
          <button
            key={a.kind}
            type="button"
            onClick={() => onAction(a.kind)}
            className={[
              'no-drag focus-ring glass-chip flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold text-white transition-[transform,background-color] duration-[var(--duration-hover)] active:scale-[0.96]',
              rainbowRing ? 'rainbow-ring' : ''
            ].join(' ')}
          >
            <a.icon size={13} strokeWidth={2.25} className="text-[var(--color-accent-2)]" />
            {a.label}
          </button>
        ))}
      </div>
      {/* This hint floats directly on the transparent window with no glass pill behind it (unlike the
          chips above), so --color-ink-3 alone — calibrated for contrast against frosted glass — washed
          out to near-invisible over a light desktop. A drop shadow + brighter tier fixes that on any
          background, light or dark. */}
      <span
        className="text-[11px] font-medium text-[color:var(--color-ink-2)]"
        style={{ textShadow: '0 1px 3px rgba(0, 0, 0, 0.65)' }}
      >
        {hint}
      </span>
    </div>
  )
}
