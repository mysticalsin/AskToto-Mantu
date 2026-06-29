import markUrl from '../assets/mantu-mark.jpg'

/**
 * Official Mantu "M" mark.
 * Uses the provided brand asset, rendered as a rounded app-icon-style glyph.
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
