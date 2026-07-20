import markUrl from '../assets/mantu-mark.jpg'

/**
 * Official Mantu "M" mark.
 *
 * The source asset (617x324) is a wide banner, not a square — the M glyph itself sits at
 * roughly x=333.5 of that 617px width, not the geometric center (x=308.5). object-cover's
 * default 50% object-position crops the square symmetrically around the image's center, which
 * left the glyph pushed off-balance (~75px of empty background on one side, ~25px on the
 * other). object-position is set to the glyph's measured center so the square crop stays
 * balanced regardless of render size.
 */
export function MantuMark({ size = 20, round = false }: { size?: number; round?: boolean }): JSX.Element {
  return (
    <img
      src={markUrl}
      alt=""
      aria-hidden="true"
      className={`select-none object-cover ${round ? 'rounded-full' : 'rounded-[22%]'}`}
      style={{ width: size, height: size, objectPosition: '58.5% center' }}
      draggable={false}
    />
  )
}
