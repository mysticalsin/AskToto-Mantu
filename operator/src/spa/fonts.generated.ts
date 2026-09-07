/**
 * GENERATED FILE. Do not edit by hand.
 * Run `node operator/scripts/build-assets.mjs` to regenerate.
 * Latin variable woff2 files copied from @fontsource-variable/{space-grotesk,inter} into
 * operator/public/fonts/ with a content-hashed name (plan 3.3, D5). A null fileName means the
 * package was not installed at build time; css.ts falls back to the system stack for that
 * family rather than ever loading a CDN font (plan lock 8).
 */

export interface GeneratedFont {
  family: string
  weightRange: string
  fileName: string | null
}

export const GENERATED_FONTS: { spaceGrotesk: GeneratedFont; inter: GeneratedFont } = {
  spaceGrotesk: {
    family: "Space Grotesk Variable",
    weightRange: "300 700",
    fileName: "space-grotesk-variable-06408904.woff2"
  },
  inter: {
    family: "Inter Variable",
    weightRange: "100 900",
    fileName: "inter-variable-3100e775.woff2"
  }
}
