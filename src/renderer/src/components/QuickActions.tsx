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
  localSummaryReady = false,
  localSuggestReady = false,
  localFallbackReady = false
}: {
  onAction: (k: QuickKind) => void
  hint?: string
  rainbowRing: boolean
  // Optional: when false, the chips render in the disabled/dimmed treatment (matching the collapse-
  // chevron pattern in Bar.tsx) with a tooltip instead of only surfacing the gate after a click bounces
  // the user into Settings. Defaults to true so existing callers are unaffected until wired.
  providerReady?: boolean
  // The per-task opt-ins. Métis Local can serve the Summarize chip without any cloud provider (its
  // non-vision branch fires summary mode, which App.tsx gates on requireProvider('summary')), and the
  // What-to-say-next chip (its transcript-backed route fires suggest mode). Neither reaches Fact-check or
  // Explain, whose branches fire answer mode.
  localSummaryReady?: boolean
  localSuggestReady?: boolean
  // The default-on safety net, and the floor for EVERY chip: main routes any mode to the on-device model
  // as the last resort when no cloud/CLI provider can answer, answer mode included. A zero-API-key install
  // with the net on therefore gets all four chips live — dimming Fact-check and Explain there would refuse
  // a request main would have served, and leave the user staring at a key prompt they do not need.
  localFallbackReady?: boolean
}): JSX.Element {
  return (
    // mt-1.5: a touch more breathing room under the bar — its --shadow-bar reaches well past its own
    // bottom edge, and the parent's 8px flex gap alone wasn't enough to keep that fade from visibly
    // touching this row's pills (read as a grey halo over a light background, even with the pills' own
    // shadow removed below).
    <div className="fade-up mt-1.5 flex flex-col items-center gap-1.5 px-1">
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        {ACTIONS.map((a) => {
          // The safety net is the ABSOLUTE floor in main's routing (localAnswerFloorEligibleFor): with it
          // on and the model ready, local serves any mode once nothing else can — including the 'answer'
          // mode behind Fact-check and Explain. So it enables every chip. The per-task useFor toggles are
          // narrower and only reach the two in-scope actions (What-to-say-next → suggest, Summarize
          // screen → summary/vision), which is why they stay listed by kind.
          const localServes =
            localFallbackReady ||
            (a.kind === 'summarize' && localSummaryReady) ||
            (a.kind === 'whatnext' && localSuggestReady)
          const enabled = providerReady || localServes
          // Only reachable with the net OFF (it enables everything), i.e. local is scoped to its in-scope
          // tasks — so for these two the honest remedy really is a cloud provider.
          const disabledHint =
            a.kind === 'factcheck' || a.kind === 'explain'
              ? 'Connect a cloud provider. Métis Local can’t do this one.'
              : 'Connect an AI provider first'
          return (
          <button
            key={a.kind}
            type="button"
            aria-label={a.label}
            title={enabled ? undefined : disabledHint}
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
