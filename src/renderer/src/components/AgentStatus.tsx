import { useLayoutEffect, useRef } from 'react'
import { ThinkingOrb, type OrbTheme } from 'thinking-orbs'
import { AGENT_STATUS, type AgentStatusKind } from '../lib/agent-status'
import { paintOrbFirstFrame } from '../lib/orb-first-frame'

export type { AgentStatusKind }

/**
 * Luxury agent status: the word first, then Jakub Antalik's thinking orb.
 * Does not rewrite their renderer. See docs/design/THINKING-ORB.md.
 */
export function AgentStatus({
  kind,
  size = 'inline',
  theme = 'dark',
  caption,
  percent,
  className = ''
}: {
  kind: AgentStatusKind
  /** Hero = caption + 64. Inline = 20; caption optional. */
  size?: 'hero' | 'inline'
  theme?: OrbTheme
  /** Default: on for hero, off for inline. Pass a string to override the mapped word. */
  caption?: boolean | string
  /** Real checkpoint percent: keep the number and force the 20px orb beside it. */
  percent?: number | null
  className?: string
}): JSX.Element {
  const spec = AGENT_STATUS[kind]
  const determinate = percent != null && Number.isFinite(percent)
  const orbSize = determinate || size === 'inline' ? 20 : 64
  const showCaption = caption === undefined ? size === 'hero' && !determinate : Boolean(caption)
  const captionText = typeof caption === 'string' ? caption : spec.caption
  const percentLabel = determinate ? `${Math.max(0, Math.min(100, Math.round(percent)))}%` : null
  const hero = size === 'hero' && !determinate
  const hostRef = useRef<HTMLDivElement>(null)

  // Package paints in useEffect (after the first browser paint). Layout-phase
  // paint puts the first sphere on the same tick as the caption — reserved slot,
  // no blank-canvas hop.
  useLayoutEffect(() => {
    const canvas = hostRef.current?.querySelector('canvas')
    if (!canvas) return
    paintOrbFirstFrame(canvas, spec.state, orbSize, theme !== 'light')
  }, [spec.state, orbSize, theme])

  return (
    <div
      ref={hostRef}
      role="status"
      aria-live="polite"
      aria-busy="true"
      data-agent-status={kind}
      data-orb-state={spec.state}
      data-orb-size={String(orbSize)}
      style={{ ['--orb-size' as string]: `${orbSize}px` }}
      className={[
        'agent-status',
        hero ? 'agent-status--hero flex items-center justify-center' : 'agent-status--inline inline-flex items-center gap-2',
        className
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {showCaption && <span className="agent-status__word">{captionText}</span>}
      {percentLabel && <span className="agent-status__word tabular-nums">{percentLabel}</span>}
      <span className="agent-status__orb" aria-hidden="true">
        <ThinkingOrb state={spec.state} size={orbSize} theme={theme} speed={1} aria-label={captionText} />
      </span>
    </div>
  )
}

/** Tight button / row slot: 20px orb, no caption. */
export function InlineOrb({
  kind = 'loading',
  theme = 'dark',
  className
}: {
  kind?: AgentStatusKind
  theme?: OrbTheme
  className?: string
}): JSX.Element {
  return <AgentStatus kind={kind} size="inline" caption={false} theme={theme} className={className} />
}
