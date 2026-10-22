import { isDesktopAdapterId, type DesktopActionRequest, type DesktopAdapterId } from './desktop-actions'
import { commandRiskNeedsConfirmation, type MetisCommandPreview, type MetisCommandRisk } from './metis-command-contract'

export { commandRiskNeedsConfirmation }

/**
 * The exact consequence a confirmation card states, built from the action and its arguments and nothing else.
 * There is no parameter through which a transcript could reach it. V03's catalog may later own the templates; the
 * result shape is what the card, the IPC state and the approval binding depend on.
 */
export type CommandPreviewResult = {
  actionId: DesktopAdapterId
  risk: MetisCommandRisk
  preview: MetisCommandPreview
  appIconKey?: string
}

/** The card shows the whole argument or no card at all: a truncated preview would hide part of what runs. */
export const COMMAND_PREVIEW_ARGUMENT_MAX = 240

// Control characters (including newlines) and bidirectional overrides/isolates can make text read differently
// from what it is. An argument containing any of them is not shown, so no card is shown either.
const UNSAFE_DISPLAY = /[\u0000-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩]/u

function shownArgument(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > COMMAND_PREVIEW_ARGUMENT_MAX) return null
  return UNSAFE_DISPLAY.test(value) ? null : value
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

export function previewForDesktopAction(
  request: DesktopActionRequest,
  platform: NodeJS.Platform = process.platform
): CommandPreviewResult | null {
  if (!request || typeof request !== 'object' || !isDesktopAdapterId(request.id)) return null
  const windows = platform === 'win32'
  switch (request.id) {
    case 'desktop.create_note': {
      const argument = shownArgument(request.args?.title)
      if (argument === null) return null
      return {
        actionId: request.id,
        risk: 'create',
        appIconKey: windows ? 'notepad' : 'notes',
        preview: {
          title: windows ? 'Create a note in Notepad' : 'Create a note in Notes',
          argument,
          confirmLabel: 'Create'
        }
      }
    }
    case 'desktop.photo_booth_capture':
      return windows
        ? {
            actionId: request.id,
            risk: 'reversible',
            appIconKey: 'camera',
            preview: { title: 'Open Camera', detail: 'Press the shutter yourself.', confirmLabel: 'Open' }
          }
        : {
            actionId: request.id,
            risk: 'create',
            appIconKey: 'photo-booth',
            preview: { title: 'Take a photo in Photo Booth', confirmLabel: 'Take photo' }
          }
    case 'desktop.google_search': {
      const argument = shownArgument(request.args?.q)
      if (argument === null) return null
      return {
        actionId: request.id,
        risk: 'read',
        appIconKey: 'browser',
        preview: { title: 'Search Google for', argument, confirmLabel: 'Search' }
      }
    }
    case 'desktop.open_notes':
      return {
        actionId: request.id,
        risk: 'reversible',
        appIconKey: windows ? 'notepad' : 'notes',
        preview: { title: 'Open Notes', confirmLabel: 'Open' }
      }
    case 'desktop.open_arc':
      return {
        actionId: request.id,
        risk: 'reversible',
        appIconKey: 'arc',
        preview: { title: 'Open Arc', confirmLabel: 'Open' }
      }
    case 'desktop.open_x':
      return {
        actionId: request.id,
        risk: 'reversible',
        appIconKey: 'browser',
        preview: { title: 'Open x.com', confirmLabel: 'Open' }
      }
  }
}
