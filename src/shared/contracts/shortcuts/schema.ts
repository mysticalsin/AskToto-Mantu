export const HOTKEY_ACTIONS: HotkeyAction[] = [
  'ask',
  'hide',
  'reset',
  'toggle-listen',
  'metis-command',
  'capture',
  'factcheck',
  'whatnext',
  'explain',
  'summarize',
  'spotlight-ref',
  'scroll-up',
  'scroll-down',
  'scroll-left',
  'scroll-right',
  'settings'
]

export type HotkeyAction =
  | 'ask'
  | 'hide'
  | 'reset'
  | 'toggle-listen'
  | 'metis-command'
  | 'capture'
  | 'factcheck'
  // The remaining Quick Action chips (QuickActions.tsx's QuickKind) + Spotlight Ref — previously only
  // 'factcheck' had a hotkey slot even though all four chips + Spotlight Ref are equally reachable by click.
  | 'whatnext'
  | 'explain'
  | 'summarize'
  | 'spotlight-ref'
  | 'scroll-up'
  | 'scroll-down'
  | 'scroll-left'
  | 'scroll-right'
  | 'settings'
  | 'agenda'

// This file is bundled into main (real Node `process`), preload (same), and the sandboxed renderer
// (no Node globals — falls back to the `navigator.platform` check already used elsewhere for
// renderer-side platform branching). `typeof` guards are required: referencing a bare undeclared
// global throws in the renderer, but `typeof x !== 'undefined'` never does.
function isWindowsPlatform(): boolean {
  if (typeof process !== 'undefined' && process.platform) return process.platform === 'win32'
  if (typeof navigator !== 'undefined' && navigator.platform) return navigator.platform.toLowerCase().includes('win')
  return false
}

export const DEFAULT_SHORTCUTS: Record<HotkeyAction, string> = {
  ask: 'CommandOrControl+Shift+Return',
  hide: 'CommandOrControl+\\',
  reset: 'CommandOrControl+Shift+R',
  'toggle-listen': 'CommandOrControl+Shift+L',
  'metis-command': 'CommandOrControl+Shift+M',
  capture: 'CommandOrControl+Shift+S',
  factcheck: 'CommandOrControl+Shift+F',
  // Unassigned by default (no free, uncontested global combo obviously reads as "what to say next" /
  // "explain" / "summarize" / "spotlight ref") — the Settings row still lets a user bind one.
  whatnext: '',
  explain: '',
  summarize: '',
  'spotlight-ref': '',
  // Ctrl+Alt+Arrow is the long-standing Intel iGPU control-panel hotkey for rotating the display on
  // Windows — Windows gets a different modifier set to avoid that collision; mac/Linux are unaffected
  // and keep Cmd/Ctrl+Alt+Arrow.
  'scroll-up': isWindowsPlatform() ? 'Alt+Shift+Up' : 'CommandOrControl+Alt+Up',
  'scroll-down': isWindowsPlatform() ? 'Alt+Shift+Down' : 'CommandOrControl+Alt+Down',
  'scroll-left': isWindowsPlatform() ? 'Alt+Shift+Left' : 'CommandOrControl+Alt+Left',
  'scroll-right': isWindowsPlatform() ? 'Alt+Shift+Right' : 'CommandOrControl+Alt+Right',
  settings: '', // no global shortcut by default; opened from bar or tray
  // Agenda is reached from the tray only (the Cluely bar redesign dropped its toolbar button). Kept out
  // of HOTKEY_ACTIONS so it gets no global key / no Settings row, but typed so the tray can trigger it.
  agenda: ''
}

