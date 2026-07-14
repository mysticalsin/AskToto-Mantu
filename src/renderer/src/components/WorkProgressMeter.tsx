export function WorkProgressMeter({
  active,
  ariaLabel,
  className = '',
  percent,
  valueText
}: {
  active: boolean
  ariaLabel: string
  className?: string
  percent: number | null
  valueText: string
}): JSX.Element {
  const determinate = percent !== null
  const scale = determinate ? percent / 100 : 0

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
      {/* A moving pulse is useful only while the denominator is unknown. Once a percentage is available,
          the filled track itself animates to each checkpoint so the UI never appears to jump backwards. */}
      {active && !determinate && <span aria-hidden="true" className="work-progress__pulse" />}
    </div>
  )
}
