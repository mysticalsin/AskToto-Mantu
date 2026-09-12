/**
 * Mode-specific recap layout. Sales / recruiting / meeting (and the other six) render as
 * distinct section cards, not one markdown blob. Used by Review and Act 2.
 */
import { recapLayoutFor, type RecapSectionDef } from '@shared/mode-recap'
import { BUILTIN_MODE_LABELS, type BuiltinMode } from '@shared/ipc'

export interface ModeRecapSectionView {
  heading: string
  body: string
}

export function modeRecapSections(markdown: string, mode: string): ModeRecapSectionView[] {
  // Imports, older summaries and translated/custom headings need a lossless reader. The shared
  // layout is a presentation preference, not an allow-list of content that may reach the user.
  const headings = [...markdown.matchAll(/^##[ \t]+([^\n]+)$/gm)]
  const sections: ModeRecapSectionView[] = []
  const preamble = markdown.slice(0, headings[0]?.index ?? markdown.length).trim()
  if (preamble) sections.push({ heading: 'Notes', body: preamble })
  headings.forEach((match, index) => {
    const raw = match[1].trim()
    const colon = raw.search(/[:：]/)
    const heading = (colon > 0 ? raw.slice(0, colon) : raw).trim()
    const inline = colon > 0 ? raw.slice(colon + 1).trim() : ''
    const body = markdown.slice(match.index + match[0].length, headings[index + 1]?.index ?? markdown.length).trim()
    sections.push({ heading, body: [inline, body].filter(Boolean).join('\n') })
  })
  if (sections.length > 0) return sections
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
  const label = Object.prototype.hasOwnProperty.call(BUILTIN_MODE_LABELS, mode) ? BUILTIN_MODE_LABELS[mode as BuiltinMode] : 'Métis'
  const layout: readonly RecapSectionDef[] = recapLayoutFor(mode)
  const ranks = new Map(layout.map((section, index) => [section.heading.toLowerCase(), index]))
  // Known sections keep the mode's usual order. Everything else follows in source order, including
  // repeated headings: a Map keyed by heading used to overwrite their earlier bodies silently.
  const ordered = sections
    .map((section, index) => ({ ...section, index, rank: ranks.get(section.heading.toLowerCase()) ?? layout.length }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)

  return (
    <div className="mode-recap flex w-full flex-col gap-2.5 text-left" data-mode={mode}>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
        {title ?? `${label} summary`}
      </div>
      {ordered.map((s) =>
        s.body ? (
          <div key={`${s.heading}-${s.index}`} className="glass-strong rounded-[14px] px-3.5 py-2.5">
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
