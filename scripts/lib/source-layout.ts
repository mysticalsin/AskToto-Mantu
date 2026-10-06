/**
 * Layout-independent source matching for contract tests.
 *
 * A Biome format pass rewraps call arguments, chains, and object literals. Tests that
 * pin behaviour or structure should ignore that wrapping rather than copy the new layout.
 */

/** Strip every whitespace run so two texts compare independent of wrapping. */
export function flattenSource(text: string): string {
  return text.replace(/\s+/g, '')
}

/** True when `source` contains `snippet` after both sides ignore wrapping. */
export function sourceContains(source: string, snippet: string): boolean {
  return flattenSource(source).includes(flattenSource(snippet))
}

/** RegExp that matches a literal source snippet regardless of Biome wrapping. */
export function sourceSnippet(snippet: string): RegExp {
  return new RegExp(
    snippet
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\./g, '\\s*\\.')
      .replace(/\\\(/g, '\\(\\s*')
      .replace(/\\\{/g, '\\{\\s*')
      .replace(/,/g, ',\\s*')
      .replace(/\\\|\\\|/g, '\\|\\|\\s*')
      .replace(/&&/g, '&&\\s*')
      .replace(/\s+/g, '\\s+')
  )
}

/** `indexOf` that finds a snippet even when Biome has rewrapped it. */
export function sourceIndexOf(source: string, snippet: string, fromIndex = 0): number {
  const search = fromIndex > 0 ? source.slice(fromIndex) : source
  const match = sourceSnippet(snippet).exec(search)
  return match ? match.index + fromIndex : -1
}

/** Slice `source` from `from` up to (excluding) the next `to`, ignoring wrapping. */
export function sourceSliceBetween(source: string, from: string, to: string): string {
  const start = sourceIndexOf(source, from)
  if (start < 0) throw new Error(`marker not found: ${from}`)
  const end = sourceIndexOf(source, to, start + 1)
  if (end < 0) throw new Error(`end marker not found after ${from}: ${to}`)
  return source.slice(start, end)
}
