import { memo } from 'react'
import { ShieldCheck, Lightbulb, MessageSquareQuote, AlignLeft } from 'lucide-react'

export type QuickKind = 'factcheck' | 'whatnext' | 'explain' | 'summarize'

const ACTIONS: { kind: QuickKind; label: string; icon: typeof ShieldCheck }[] = [
  { kind: 'whatnext', label: 'What to say next', icon: MessageSquareQuote },
  { kind: 'factcheck', label: 'Fact-check', icon: ShieldCheck },
  { kind: 'explain', label: 'Explain', icon: Lightbulb },
  { kind: 'summarize', label: 'Summarize screen', icon: AlignLeft }
]

export const QuickActions = memo(function QuickActions({
  onAction,
  hint,
  rainbowRing,
  providerReady = true,
  localSummaryReady = false
}: {
  onAction: (k: QuickKind) => void
  hint?: string
  rainbowRing: boolean
  // Optional: when false, the chips render in the disabled/dimmed treatment (matching the collapse-
  // chevron pattern in Bar.tsx) with a tooltip instead of only surfacing the gate after a click bounces
  // the user into Settings. Defaults to true so existing callers are unaffected until wired.
  providerReady?: boolean
  // Métis Local can serve the Summarize chip without any cloud provider (its non-vision branch fires
  // summary mode, which App.tsx gates on requireProvider('summary')). Only that chip qualifies: the
  // other three all have direct answer-mode branches only cloud serves, so enabling them local-only
  // would just bounce the user into Settings after the click instead of before it.
  localSummaryReady?: boolean
}): JSX.Element {
  return (
    // mt-1.5: a touch more breathing room under the bar — its --shadow-bar reaches well past its own
    // bottom edge, and the parent's 8px flex gap alone wasn't enough to keep that fade from visibly
    // touching this row's pills (read as a grey halo over a light background, even with the pills' own
    // shadow removed below).
    <div className="fade-up mt-1.5 flex flex-col items-center gap-1.5 px-1">
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        {ACTIONS.map((a) => {
          const enabled = providerReady || (a.kind === 'summarize' && localSummaryReady)
          return (
          <button
            key={a.kind}
            type="button"
            aria-label={a.label}
            title={enabled ? undefined : 'Connect an AI provider first'}
            aria-disabled={!enabled}
            disabled={!enabled}
            onClick={() => onAction(a.kind)}
            className={[
              'no-drag focus-ring glass-chip flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold text-white transition-[transform,background-color] duration-[var(--duration-hover)] active:scale-[0.96]',
              rainbowRing ? 'rainbow-ring' : '',
              enabled ? '' : 'cursor-not-allowed opacity-40'
            ].join(' ')}
          >
            <a.icon size={13} strokeWidth={2.25} className="text-[var(--color-accent-2)]" />
            {a.label}
          </button>
          )
        })}
      </div>
      {/* This hint floats directly on the transparent window with no glass pill behind it (unlike the
          chips above), so --color-ink-3 alone — calibrated for contrast against frosted glass — washed
          out to near-invisible over a light desktop. A drop shadow + brighter tier fixes that on any
          background, light or dark. */}
      {hint && (
        <span
          className="text-[11px] font-medium text-[color:var(--color-ink-2)]"
          style={{ textShadow: '0 1px 3px rgba(0, 0, 0, 0.65)' }}
        >
          {hint}
        </span>
      )}
    </div>
  )
})
