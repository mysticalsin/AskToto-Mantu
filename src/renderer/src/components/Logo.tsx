/** AskToto mark — minimalist incognito glasses. Own glyph, not Cluely's. */
export function Logo({ size = 18 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 11.5c1.2-.6 2.6-.9 4-.9 1.8 0 3.2.6 4 2" />
      <path d="M22 11.5c-1.2-.6-2.6-.9-4-.9-1.8 0-3.2.6-4 2" />
      <circle cx="6" cy="14.5" r="3.4" />
      <circle cx="18" cy="14.5" r="3.4" />
      <path d="M9.4 14.2c.8-.5 1.7-.7 2.6-.7s1.8.2 2.6.7" />
    </svg>
  )
}
