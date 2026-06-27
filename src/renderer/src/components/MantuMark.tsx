import markUrl from '../assets/mantu-mark.jpg'

/**
 * Official Mantu "M" mark.
 * Uses the provided brand asset, rendered as a rounded app-icon-style glyph.
 */
export function MantuMark({ size = 20 }: { size?: number }): JSX.Element {
  return (
    <img
      src={markUrl}
      alt=""
      aria-hidden="true"
      className="select-none rounded-[22%] object-cover"
      style={{ width: size, height: size }}
      draggable={false}
    />
  )
}
