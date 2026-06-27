import logoUrl from '../assets/mantu-logo-tagline.png'

/**
 * Official Mantu brand wordmark with tagline.
 * Uses the provided PNG asset so branding matches the corporate lockup exactly.
 */
export function MantuLogo({
  size = 120,
  tagline = true
}: {
  size?: number
  tagline?: boolean
}): JSX.Element {
  return (
    <img
      src={logoUrl}
      alt="Mantu — Audacious ideas, Delivered beyond"
      className="select-none object-contain"
      style={{
        width: size,
        height: 'auto',
        maxHeight: tagline ? size * 0.48 : size
      }}
      draggable={false}
    />
  )
}
