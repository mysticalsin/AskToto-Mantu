import logoUrl from '../assets/mantu-logo-tagline.png'

/**
 * Official Mantu brand wordmark, optionally with tagline.
 *
 * The source PNG (330x159) bakes the "Audacious ideas, Delivered beyond" caption into the
 * raster in the brand's dark purple, which reads at near-zero contrast against this app's
 * always-dark background. Rather than show that illegible caption, the raster is clipped to
 * just the wordmark (its content ends around row 105 of 159; the rest is the baked tagline
 * plus padding) and the tagline is rendered as a real text node in a contrast-safe ink color
 * instead. A proper long-term fix would be a mark-only transparent asset (no baked caption)
 * plus the brand's actual tagline typeface, which we don't have on hand here.
 */
export function MantuLogo({
  size = 120,
  tagline = true
}: {
  size?: number
  tagline?: boolean
}): JSX.Element {
  const markHeight = size * (105 / 330)
  return (
    <div className="flex select-none flex-col items-center" style={{ width: size }}>
      <div style={{ width: size, height: markHeight, overflow: 'hidden' }}>
        <img
          src={logoUrl}
          alt="Mantu"
          // The raster's wordmark is the brand's DARK purple — on this app's always-dark background it
          // was effectively invisible ("the logo doesn't appear"). White it out for guaranteed
          // contrast: brightness(0) flattens the letterforms to black, invert(1) lifts them to white —
          // exact brand shapes, always readable on the dark theme.
          style={{ width: size, height: 'auto', filter: 'brightness(0) invert(1)', opacity: 0.92 }}
          draggable={false}
        />
      </div>
      {tagline && (
        <p
          className="m-0 mt-1 select-none text-center font-ui text-[color:var(--color-ink-3)]"
          style={{ fontSize: Math.max(10, size * 0.06) }}
        >
          Audacious ideas, Delivered beyond
        </p>
      )}
    </div>
  )
}
