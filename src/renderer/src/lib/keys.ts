// Platform-correct keyboard-shortcut display. macOS shows modifier glyphs (⌘⌥⇧⌃↵); Windows and Linux
// show the word tokens users there expect (Ctrl, Alt, Shift, Win, Enter). The app stores every shortcut
// as an Electron accelerator string ("CommandOrControl+Shift+S"), so both the Settings key chips and the
// static hints/tooltips scattered across the UI render through the SAME two helpers here — no component
// hardcodes a glyph, so a Windows user never sees a ⌘ they cannot press.

// Electron sets navigator.platform to "Win32" on Windows, "MacIntel" on mac. navigator.platform is
// deprecated but still populated in Chromium and is the signal the rest of the renderer already uses.
export const isWindows = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('win')

/**
 * Render an Electron accelerator string for the current OS, keeping the "+" separators so callers that
 * split into per-key chips (Settings) still work. macOS -> glyphs; Windows/Linux -> word tokens.
 */
export function displayAccelerator(a: string): string {
  if (!a) return ''
  if (isWindows) {
    return a
      .replace(/CommandOrControl/g, 'Ctrl')
      .replace(/CmdOrCtrl/g, 'Ctrl')
      .replace(/Command/g, 'Win')
      .replace(/Meta/g, 'Win')
      .replace(/Super/g, 'Win')
      .replace(/Control/g, 'Ctrl')
      .replace(/Return/g, 'Enter')
  }
  return a
    .replace(/CommandOrControl/g, '⌘')
    .replace(/CmdOrCtrl/g, '⌘')
    .replace(/Command/g, '⌘')
    .replace(/Meta/g, '⌘')
    .replace(/Control/g, 'Ctrl')
    .replace(/Shift/g, '⇧')
    .replace(/Alt/g, '⌥')
    .replace(/Return/g, '↵')
}

/**
 * Compact one-token label for inline hints and tooltips (e.g. "⌘⇧S" on mac, "Ctrl+Shift+S" on Windows).
 * Mac glyphs read fine run together; word tokens need the "+" to stay legible, so only mac drops it.
 */
export function accelLabel(a: string): string {
  const d = displayAccelerator(a)
  return isWindows ? d : d.replace(/\+/g, '')
}
