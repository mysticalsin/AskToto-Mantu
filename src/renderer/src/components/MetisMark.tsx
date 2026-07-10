import markUrl from '../assets/metis-mark.png'

/**
 * Métis app mark — the goddess-and-constellation icon, rendered as a rounded app-icon-style glyph.
 * Product identity (bar, settings header, onboarding). The Mantu company mark stays MantuMark/MantuLogo.
 */
export function MetisMark({ size = 20, round = false }: { size?: number; round?: boolean }): JSX.Element {
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
