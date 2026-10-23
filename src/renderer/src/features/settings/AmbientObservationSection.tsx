/**
 * AmbientObservationSection.tsx — Settings › Privacy › Background observation (R111, D-19).
 * Read-only rows in the same plain style as Organisation reporting: one sentence on what is read, one on what is kept.
 */
import { AMBIENT_OBSERVATION_ROWS } from '@shared/ambient-observation'

export function AmbientObservationSection(): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      {AMBIENT_OBSERVATION_ROWS.map((row) => (
        <div key={row.id} className="flex flex-col gap-1">
          <p className="m-0 px-1 text-[12px] font-medium text-[color:var(--cl-foreground)]">{row.label}</p>
          <p className="m-0 px-1 text-[12px] leading-relaxed text-[color:var(--cl-foreground)]">{row.detail}</p>
          <p className="m-0 px-1 text-[11px] leading-relaxed text-[color:var(--cl-muted-foreground)]">{row.keeps}</p>
        </div>
      ))}
    </div>
  )
}
