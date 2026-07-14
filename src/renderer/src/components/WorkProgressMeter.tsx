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
      className={`work-progress ${className}`}
      role="progressbar"
    >
      <span aria-hidden="true" className="work-progress__value" style={{ transform: `scaleX(${scale})` }} />
      {active && <span aria-hidden="true" className="work-progress__pulse" />}
    </div>
  )
}
