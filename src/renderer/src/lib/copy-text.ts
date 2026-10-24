/**
 * Copy exactly what the user is looking at (G55): the text goes to the clipboard verbatim (paragraph breaks, list
 * markers, indentation and trailing newlines untouched), and a failure is returned as a message, never swallowed.
 */
export async function copyText(
  text: string,
  clipboard: { writeText(text: string): Promise<void> }
): Promise<string | null> {
  try {
    await clipboard.writeText(text)
    return null
  } catch (e) {
    return `Copy failed: ${e instanceof Error ? e.message : String(e)}`
  }
}
