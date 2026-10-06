/**
 * contrast.ts — WCAG 2.2 contrast for the right-edge surfaces (M2-0202, spec v3 §8, §13): the layout tests
 * judge every text sample of a rendered surface with it, against the colours the browser computed.
 *
 * Invariants: colours are sRGB [r, g, b] in 0-255 with an optional alpha in 0-1; a translucent layer is
 * composited over the opaque colour under it before any ratio is taken; text is "large" at 24 px, or 18.66 px
 * bold, and needs 3:1, as does a graphical object; all other text needs 4.5:1 (SC 1.4.3, 1.4.11).
 */

export type Rgb = readonly [number, number, number]
export type Rgba = readonly [number, number, number, number]

/** Parses a computed `rgb()` / `rgba()` colour (both the comma and the space syntax). Null for anything else. */
export function parseCssColor(value: string): Rgba | null {
  const match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(value.trim())
  if (!match) return null
  const alphaText = match[4]
  const alpha =
    alphaText === undefined ? 1 : alphaText.endsWith('%') ? Number.parseFloat(alphaText) / 100 : Number(alphaText)
  return [Number(match[1]), Number(match[2]), Number(match[3]), alpha]
}

function channel(value: number): number {
  const c = value / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** `top` painted over the opaque `bottom`. */
export function composite(top: Rgba, bottom: Rgb): Rgb {
  const alpha = top[3]
  return [0, 1, 2].map((i) => top[i] * alpha + bottom[i] * (1 - alpha)) as unknown as Rgb
}

export function requiredContrast(sample: { fontSizePx: number; fontWeight: number; graphical?: boolean }): number {
  if (sample.graphical) return 3
  const large = sample.fontSizePx >= 24 || (sample.fontSizePx >= 18.66 && sample.fontWeight >= 700)
  return large ? 3 : 4.5
}

/**
 * The ratio of a text colour over its background stack: `layers` are the background colours from the
 * outermost ancestor in, each composited over the one before, starting on the opaque `backdrop`.
 */
export function textContrast(fg: Rgba, layers: readonly Rgba[], backdrop: Rgb): number {
  const bg = layers.reduce<Rgb>((under, layer) => composite(layer, under), backdrop)
  return contrastRatio(composite(fg, bg), bg)
}
