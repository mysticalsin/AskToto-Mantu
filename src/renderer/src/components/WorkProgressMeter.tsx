export function WorkProgressMeter({
  active,
  ariaLabel,
  className = '',
  percent,
  valueText,
  pulseAtFull = false
}: {
  active: boolean
  ariaLabel: string
  className?: string
  percent: number | null
  valueText: string
  /** Keep the animated pulse visible even once percent reaches 100 — for a phase (e.g. writing a
   *  post-transcription summary) that has no further measurable checkpoint but is still busy, so a plain
   *  full determinate bar would otherwise look finished/idle rather than working. Reuses the exact same
   *  translate/opacity-only `.work-progress__pulse` animation as the indeterminate state, just layered
   *  over a full track instead of an empty one. Defaults to false — every other caller (e.g. the Mantu
   *  Intelligence index meter) keeps its existing determinate-at-100%-means-done rendering. */
  pulseAtFull?: boolean
}): JSX.Element {
  const determinate = percent !== null
  const scale = determinate ? percent / 100 : 0
  const showPulse = active && (!determinate || (pulseAtFull && percent === 100))

  return (
    <div
      aria-busy={active || undefined}
      aria-label={ariaLabel}
      aria-valuemax={determinate ? 100 : undefined}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuenow={determinate ? percent : undefined}
      aria-valuetext={valueText}
      className={`work-progress ${determinate ? 'work-progress--determinate' : 'work-progress--indeterminate'} ${className}`}
      role="progressbar"
    >
      <span aria-hidden="true" className="work-progress__value" style={{ transform: `scaleX(${scale})` }} />
      {/* A moving pulse is useful while the denominator is unknown, OR (pulseAtFull) while the bar is
          deliberately shown full even though the underlying work isn't actually finished yet. Once a real
          percentage is available and pulseAtFull isn't set, the filled track itself animates to each
          checkpoint so the UI never appears to jump backwards. */}
      {showPulse && <span aria-hidden="true" className="work-progress__pulse" />}
    </div>
  )
}
