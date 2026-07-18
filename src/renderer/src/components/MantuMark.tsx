/**
 * Official Mantu "M" mark — hand-drawn as inline SVG.
 *
 * History: every raster approach (object-cover crop of the banner, then a green-/min-channel-keyed
 * PNG tile) read as off-center or seamed, because the source banner has a two-tone background split,
 * decorative streaks, and a glyph whose lighter-left / brighter-right halves defeat pixel-centroid
 * centering. A vector redraw ends that class of problem: two overlapping round-capped chevrons (the
 * lighter-left + brighter-right strokes whose crossing forms the bright center diamond), centered in
 * the viewBox BY CONSTRUCTION, so it's crisp and perfectly centered at 14px, 30px, or 92px with no
 * asset, no seam, and no per-size nudging.
 */
export function MantuMark({ size = 20, round = false }: { size?: number; round?: boolean }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      aria-hidden="true"
      className="block select-none"
    >
      <rect x="0" y="0" width="100" height="100" rx={round ? 50 : 22} fill="#740EB0" />
      <g fill="none" stroke="#F8F4FB" strokeLinecap="round" strokeLinejoin="round" strokeWidth={15}>
        <polyline points="21,72 38,27 55,72" strokeOpacity={0.42} />
        <polyline points="45,72 62,27 79,77" strokeOpacity={0.9} />
      </g>
    </svg>
  )
}
