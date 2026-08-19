// Electron accelerator safety — the last gate before a stored hotkey string becomes an OS-global binding.
//
// settings.json is a user-editable file and the `shortcuts` field in ipc.ts accepts any string
// (deliberately: '' is the unbind sentinel), so main cannot treat what it reads as well-formed. MQA-184:
// the Settings recorder used to commit 'Shift+Tab', and globalShortcut.register happily claimed reverse-tab
// navigation process-wide for as long as Métis ran — a keyboard user then could not tab backwards anywhere.

/** Modifier tokens Electron accepts, lower-cased for comparison. */
const MODIFIERS = new Set([
  'command',
  'cmd',
  'control',
  'ctrl',
  'commandorcontrol',
  'cmdorctrl',
  'alt',
  'option',
  'altgr',
  'shift',
  'super',
  'meta'
])

/** Keys the OS and every app need for keyboard navigation — binding one globally takes it away everywhere. */
const RESERVED_KEYS = new Set(['tab'])

/**
 * Whether `accel` is a shape Métis is willing to bind globally: at least one real modifier (a bare key
 * would fire on ordinary typing), a main key that is not itself a modifier, and no reserved navigation key.
 */
export function isSafeAccelerator(accel: string): boolean {
  const parts = accel.split('+')
  const main = (parts.pop() ?? '').trim().toLowerCase()
  if (!main || MODIFIERS.has(main) || RESERVED_KEYS.has(main)) return false
  if (parts.length === 0) return false
  return parts.every((p) => MODIFIERS.has(p.trim().toLowerCase()))
}
