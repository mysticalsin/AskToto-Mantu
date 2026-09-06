/**
 * Official Plane mark — simple-icons `plane` path (CC0; commit 978656df).
 * Trademark remains Plane Software. Official hex #121212 is near-black; paint with
 * currentColor on dark glass so the official path still reads.
 * Source: https://plane.so/brand-logos/logo-with-wordmark.svg
 * See docs/design/BRAIN-CONNECTORS.md.
 */
export function PlaneMark({ size = 28 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className="block shrink-0 text-[color:var(--cl-foreground)]"
    >
      <title>Plane</title>
      <path
        fill="currentColor"
        d="M0 5.358a.854.854 0 0 1 1.235-.767L6.134 7.05v5.768c0 .81.456 1.553 1.179 1.915l4.42 2.218v1.692a.853.853 0 0 1-1.235.766L1.18 14.732A2.14 2.14 0 0 1 0 12.817zm6.134 0a.853.853 0 0 1 1.235-.766l4.898 2.458v5.768c0 .81.457 1.552 1.18 1.915l4.42 2.218v1.692a.853.853 0 0 1-1.235.765l-4.899-2.457v-5.769a2.14 2.14 0 0 0-1.179-1.914L6.134 7.05zm6.133 0a.853.853 0 0 1 1.235-.766l9.319 4.676A2.14 2.14 0 0 1 24 11.182v7.46a.853.853 0 0 1-1.235.766l-4.899-2.457v-5.769a2.14 2.14 0 0 0-1.179-1.914l-4.42-2.218z"
      />
    </svg>
  )
}
