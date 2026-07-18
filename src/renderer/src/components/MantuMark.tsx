import markUrl from '../assets/mantu-mark-tile.png'

/**
 * Official Mantu "M" mark.
 *
 * The source banner (mantu-mark.jpg, 617×324) could not be used directly: object-cover center-cropped
 * it at render time, so the banner's two-tone background split + edge streaks landed inside the square
 * and read as a BROKEN/glitched icon. mantu-mark-tile.png is a rebuilt square tile — the M pixels
 * lifted from the banner (green-channel key: bg purple g≈14, M lobes g≥130) composited centered on the
 * uniform brand purple — so nothing is cropped or seamed at render time at any size.
 */
export function MantuMark({ size = 20, round = false }: { size?: number; round?: boolean }): JSX.Element {
  return (
    <img
      src={markUrl}
      alt=""
      aria-hidden="true"
      className={`select-none object-cover ${round ? 'rounded-full' : 'rounded-[22%]'}`}
      style={{ width: size, height: size }}
      draggable={false}
    />
  )
}
