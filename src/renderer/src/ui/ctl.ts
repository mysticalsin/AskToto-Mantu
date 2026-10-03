// Shared control class for inputs + native <select>s. The trailing bits fix a Windows-only bug where a
// native <select> rendered as a blank white box (white text on a white native control) until you clicked
// it to open the popup: `[color-scheme:dark]` makes Chromium paint the native select control dark on
// Windows, and the `[&>option]:…` rules give the dropdown options an explicit dark background + light text
// (Windows renders <option> from its OWN colors, defaulting to white — the app's bg/text don't cascade in).
// The `option` selector only matches <select> children, so plain inputs sharing this class are unaffected.
export const ctl =
  'no-drag font-body cl-input cl-focus min-w-0 max-w-full px-3 py-2.5 text-[13px] text-[color:var(--cl-foreground)] [color-scheme:dark] [&>option]:bg-[#1A0033] [&>option]:text-white'
