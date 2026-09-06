/** Fleet value math for Mission Control. Transparent estimate — not audited finance. */

/** Default fully-loaded hourly rate used for the EBITDA / value proxy (€/hr). */
export const HOURLY_RATE_EUR = 85

export function formatSavedDuration(savedMinutes: number): string {
  const mins = Math.max(0, Math.round(savedMinutes))
  if (mins < 60) return `${mins} min`
  const hours = mins / 60
  const rounded = Math.round(hours * 10) / 10
  const label = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
  return `${label} ${rounded === 1 ? 'hr' : 'hrs'}`
}

/** Estimated value created = saved hours × €85. */
export function estimateValueEur(savedMinutes: number, hourlyRateEur = HOURLY_RATE_EUR): number {
  const mins = Math.max(0, Number.isFinite(savedMinutes) ? savedMinutes : 0)
  const rate = Number.isFinite(hourlyRateEur) && hourlyRateEur > 0 ? hourlyRateEur : HOURLY_RATE_EUR
  return Math.round((mins / 60) * rate)
}

export function formatValueEur(euros: number): string {
  const n = Math.max(0, Math.round(euros))
  return `€${n.toLocaleString('en-IE')}`
}
