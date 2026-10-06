/**
 * Layout-independent source matching for contract tests.
 *
 * A Biome format pass rewraps call arguments and object literals. Tests that pin
 * behaviour or structure should ignore that wrapping rather than copy the new layout.
 */

/** Collapse every whitespace run so two texts compare independent of wrapping. */
export function flattenSource(text: string): string {
  return text.replace(/\s+/g, ' ')
}

/** True when `source` contains `snippet` after both sides ignore wrapping. */
export function sourceContains(source: string, snippet: string): boolean {
  return flattenSource(source).includes(flattenSource(snippet))
}

/** RegExp that matches a literal source snippet regardless of Biome wrapping. */
export function sourceSnippet(snippet: string): RegExp {
  return new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
}

/** `indexOf` that finds a snippet even when Biome has rewrapped it. */
export function sourceIndexOf(source: string, snippet: string): number {
  const match = sourceSnippet(snippet).exec(source)
  return match ? match.index : -1
}
