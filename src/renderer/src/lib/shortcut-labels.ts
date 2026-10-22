import type { HotkeyAction } from '@shared/ipc'

/** Human names of the global shortcuts, shared by the Settings rows and the overlay's conflict toast. */
export const SHORTCUT_LABELS: Record<HotkeyAction, string> = {
  ask: 'Ask (global)',
  hide: 'Show / hide',
  capture: 'Capture screen',
  factcheck: 'Fact-check',
  'toggle-listen': 'Toggle Listen',
  'metis-command': 'Summon Métis command',
  reset: 'New / reset',
  whatnext: 'What to say next',
  explain: 'Explain',
  summarize: 'Summarize screen',
  'spotlight-ref': 'Spotlight Ref',
  'scroll-up': 'Move up',
  'scroll-down': 'Move down',
  'scroll-left': 'Move left',
  'scroll-right': 'Move right',
  settings: 'Open settings',
  agenda: "Today's agenda" // tray-only action; not listed in HOTKEY_ACTIONS so it renders no shortcut row
}
