/** The keyboard model of History's meeting list (pure; use-row-keyboard.ts applies it to the DOM). */

/** The row index a navigation key moves to, or null when the key is not one (or the list is empty). */
export function rowStep(key: string, index: number, count: number): number | null {
  if (count <= 0) return null
  if (key === 'ArrowDown') return Math.min(count - 1, index + 1)
  if (key === 'ArrowUp') return Math.max(0, index - 1)
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}

/** Where focus goes when a row is removed: the next row, else the previous one, else nowhere. */
export function neighborAfterRemoval(files: readonly string[], removed: string): string | null {
  const index = files.indexOf(removed)
  if (index === -1) return null
  return files[index + 1] ?? files[index - 1] ?? null
}

/** The one row that is a Tab stop (roving tabindex): the selected row when it is listed, else the first. */
export function tabStopFile(files: readonly string[], selected: string | null): string | null {
  if (selected && files.includes(selected)) return selected
  return files[0] ?? null
}
