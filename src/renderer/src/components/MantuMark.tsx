import markUrl from '../assets/mantu-mark-tile.png'

/**
 * Official Mantu "M" mark — the REAL brand glyph.
 *
 * mantu-mark-tile.png is the actual M lifted pixel-for-pixel from the brand banner (its true gradient
 * and shading preserved via a min-channel alpha key that drops the banner's purple background + streaks),
 * then composited centered — equal margins by construction — on the uniform brand purple. Using the
 * authentic asset rather than a vector redraw, cropped square once so nothing is re-cropped or seamed at
 * render time at any size.
 */
export function MantuMark({ size = 20, round = false }: { size?: number; round?: boolean }): JSX.Element {
  return (
    <img
      src={markUrl}
      alt=""
      aria-hidden="true"
      className={`block max-h-none max-w-none shrink-0 select-none ${round ? 'rounded-full' : 'rounded-[22%]'}`}
      style={{ width: size, height: size, maxWidth: 'none', maxHeight: 'none' }}
      draggable={false}
    />
  )
}
