import { isDesktopAdapterId, type DesktopActionRequest, type DesktopAdapterId } from './desktop-actions'
import type { MetisCommandPreview, MetisCommandRisk } from './metis-command-contract'
import { classifyDesktopRequest, previewFor, validateDesktopRequest, voicePlatformOf } from './voice/catalog'

/**
 * The exact consequence a confirmation card states, as main publishes it. The wording, the class and the argument
 * validation all come from the voice catalog (V03): a request the catalog rejects (out of bounds, control or
 * bidirectional characters, unknown action, unsupported on this platform) has no preview and so no card. This
 * module adds only what the card itself needs on top: the verb for the default button, the app icon key, and the
 * body text the catalog's one-line preview omits, so the card never hides part of what will run. There is no
 * parameter through which a transcript could reach it.
 */
export type CommandPreviewResult = {
  actionId: DesktopAdapterId
  risk: MetisCommandRisk
  preview: MetisCommandPreview
  appIconKey?: string
}

const LABELS: Record<DesktopAdapterId, string> = {
  'desktop.open_notes': 'Open Notes',
  'desktop.create_note': 'Create note',
  'desktop.open_arc': 'Open Arc',
  'desktop.google_search': 'Search Google',
  'desktop.open_x': 'Open x.com',
  'desktop.photo_booth_capture': 'Take a photo'
}

/** A short action name for recovery copy. Never includes arguments. */
export function desktopActionLabel(id: string): string | null {
  return isDesktopAdapterId(id) ? LABELS[id] : null
}

const CONFIRM_LABEL: Record<DesktopAdapterId, string> = {
  'desktop.open_notes': 'Open',
  'desktop.create_note': 'Create',
  'desktop.open_arc': 'Open',
  'desktop.google_search': 'Search',
  'desktop.open_x': 'Open',
  'desktop.photo_booth_capture': 'Take photo'
}

const APP_ICON: Record<DesktopAdapterId, string> = {
  'desktop.open_notes': 'notes',
  'desktop.create_note': 'notes',
  'desktop.open_arc': 'arc',
  'desktop.google_search': 'browser',
  'desktop.open_x': 'browser',
  'desktop.photo_booth_capture': 'photo-booth'
}

export function previewForDesktopAction(
  request: DesktopActionRequest,
  platform: NodeJS.Platform | string = process.platform
): CommandPreviewResult | null {
  // Re-validated here, so a request that skipped the grammar (the panel path) is held to the same bounds.
  const valid = validateDesktopRequest(request)
  if (!valid) return null
  const voicePlatform = voicePlatformOf(platform)
  const risk = classifyDesktopRequest(valid, voicePlatform)
  if (risk === null) return null
  const base = previewFor(valid, voicePlatform)
  const windows = voicePlatform === 'win32'
  const body = valid.id === 'desktop.create_note' ? valid.args.body : undefined
  const detail =
    body ?? (valid.id === 'desktop.photo_booth_capture' && windows ? 'Press the shutter yourself.' : undefined)
  return {
    actionId: valid.id,
    risk,
    appIconKey: windows && APP_ICON[valid.id] === 'notes' ? 'notepad' : APP_ICON[valid.id],
    preview: {
      title: base.title,
      ...(base.argument !== undefined ? { argument: base.argument } : {}),
      ...(detail !== undefined ? { detail } : {}),
      confirmLabel: windows && valid.id === 'desktop.photo_booth_capture' ? 'Open' : CONFIRM_LABEL[valid.id]
    }
  }
}

/**
 * The card for a request that came from outside Métis (G37 handoff). The text says so in its title and the person's
 * own words stay quoted as the argument. The origin claim itself is never shown as trusted: it is unauthenticated.
 */
export function previewFromOutside(result: CommandPreviewResult): CommandPreviewResult {
  const title =
    result.actionId === 'desktop.create_note'
      ? 'Another app asks Métis to create a note'
      : `Another app asks Métis: ${result.preview.title.charAt(0).toLowerCase()}${result.preview.title.slice(1)}`
  return { ...result, preview: { ...result.preview, title } }
}
