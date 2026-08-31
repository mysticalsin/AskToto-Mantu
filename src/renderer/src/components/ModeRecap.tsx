/**
 * Mode-specific recap layout. Sales / recruiting / meeting (and the other six) render as
 * distinct section cards, not one markdown blob. Used by Review and Act 2.
 */
import { recapLayoutFor, splitRecapSections, type RecapSectionDef } from '@shared/mode-recap'
import { BUILTIN_MODE_LABELS, type BuiltinMode } from '@shared/ipc'

export interface ModeRecapSectionView {
  heading: string
  body: string
}

export function modeRecapSections(markdown: string, mode: string): ModeRecapSectionView[] {
  const split = splitRecapSections(markdown)
  if (split.length > 0) return split
  const layout = recapLayoutFor(mode)
  return layout.map((s) => ({ heading: s.heading, body: '' }))
}

export function ModeRecapView({
  mode,
  sections,
  title
}: {
  mode: string
  sections: ModeRecapSectionView[]
  title?: string
}): JSX.Element {
  const label = mode in BUILTIN_MODE_LABELS ? BUILTIN_MODE_LABELS[mode as BuiltinMode] : 'Métis'
  const layout: readonly RecapSectionDef[] = recapLayoutFor(mode)
  const byHeading = new Map(sections.map((s) => [s.heading.toLowerCase(), s.body]))
  const ordered =
    layout.length > 0
      ? layout.map((def) => ({
          heading: def.heading,
          body: byHeading.get(def.heading.toLowerCase()) ?? ''
        }))
      : sections

  return (
    <div className="mode-recap flex w-full flex-col gap-2.5 text-left" data-mode={mode}>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
        {title ?? `${label} summary`}
      </div>
      {ordered.map((s) =>
        s.body ? (
          <div key={s.heading} className="glass-strong rounded-[14px] px-3.5 py-2.5">
            <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-[color:var(--color-accent-2)]">
              {s.heading}
            </p>
            <div className="mt-1 whitespace-pre-wrap text-[13px] leading-snug text-[color:var(--color-ink)]">
              {s.body}
            </div>
          </div>
        ) : null
      )}
    </div>
  )
}
