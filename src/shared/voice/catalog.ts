/**
 * The voice action catalog (V03): the one list of things a spoken request may do, what class each is, what
 * its arguments may hold, and how it is described on the confirmation card.
 *
 * Everything a transcript, a classifier or a renderer proposes is validated here before it can become a
 * `DesktopActionRequest`. A request that is not in this catalog, or whose arguments are out of bounds, does
 * not exist as far as main is concerned. Pure: no I/O, no platform calls.
 */
import { z } from 'zod'
import { DESKTOP_ADAPTER_IDS, type DesktopActionRequest, type DesktopAdapterId } from '../desktop-actions'

/** How reversible an action is. Read and reversible run at once; the rest need the confirmation card. */
export type VoiceActionClass = 'read' | 'reversible' | 'create' | 'send' | 'type' | 'delete'
export type VoicePlatform = 'darwin' | 'win32' | 'other'

/**
 * How an effect can be proven. `readback`: the adapter reads the result back and echoes a bound receipt.
 * `handoff`: the request is handed to the operating system and nothing can be read back, so the honest
 * outcome is unverified.
 */
export type VoiceVerification = 'readback' | 'handoff'

export const NOTE_TITLE_MAX_CHARS = 120
export const NOTE_BODY_MAX_CHARS = 2_000
export const SEARCH_QUERY_MAX_CHARS = 200

/**
 * Controls, line and paragraph separators, bidirectional overrides and isolates, byte-order marks and the
 * zero-width characters that can reorder or hide text on a card. Zero-width joiner (U+200D) stays: emoji
 * sequences need it.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2069\ufeff]/u
// A body may span lines, so newline and tab stay.
// eslint-disable-next-line no-control-regex
const UNSAFE_BLOCK =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2069\ufeff]/u

const line = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0 && !UNSAFE_LINE.test(value) && value === value.trim())
const block = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0 && !UNSAFE_BLOCK.test(value))

const noArgs = z.object({}).strict()
const browser = z.literal('arc')

const RequestSchema = z.discriminatedUnion('id', [
  z.object({ id: z.literal('desktop.open_notes'), args: noArgs }).strict(),
  z
    .object({
      id: z.literal('desktop.create_note'),
      args: z.object({ title: line(NOTE_TITLE_MAX_CHARS), body: block(NOTE_BODY_MAX_CHARS).optional() }).strict()
    })
    .strict(),
  z.object({ id: z.literal('desktop.open_arc'), args: noArgs }).strict(),
  z
    .object({
      id: z.literal('desktop.google_search'),
      args: z.object({ q: line(SEARCH_QUERY_MAX_CHARS), browser: browser.optional() }).strict()
    })
    .strict(),
  z.object({ id: z.literal('desktop.open_x'), args: z.object({ browser: browser.optional() }).strict() }).strict(),
  z.object({ id: z.literal('desktop.photo_booth_capture'), args: noArgs }).strict()
])

/**
 * Validate an untrusted request (a grammar match, a classifier answer, anything). Returns a fresh, frozen
 * request holding only the known fields, or null. Quotes, `end tell`, `& do shell script` and the like are
 * ordinary text here: they are valid titles. Making them harmless is the adapters' job (argv, never script).
 */
export function validateDesktopRequest(raw: unknown): DesktopActionRequest | null {
  const parsed = RequestSchema.safeParse(raw)
  if (!parsed.success) return null
  const { id, args } = parsed.data
  return Object.freeze({ id, args: Object.freeze({ ...args }) }) as DesktopActionRequest
}

interface CatalogEntry {
  /** Class per platform; null means this platform cannot run the action at all. */
  classes: Readonly<Record<VoicePlatform, VoiceActionClass | null>>
  verification: Readonly<Record<VoicePlatform, VoiceVerification>>
}

const same = (value: VoiceActionClass): CatalogEntry['classes'] => ({ darwin: value, win32: value, other: null })

const CATALOG: Readonly<Record<DesktopAdapterId, CatalogEntry>> = {
  'desktop.open_notes': {
    classes: same('reversible'),
    verification: { darwin: 'readback', win32: 'handoff', other: 'handoff' }
  },
  'desktop.create_note': {
    classes: same('create'),
    verification: { darwin: 'readback', win32: 'readback', other: 'handoff' }
  },
  // Windows has no trusted Arc path, so the action does not exist there (it never falls back to another browser).
  'desktop.open_arc': {
    classes: { darwin: 'reversible', win32: null, other: null },
    verification: { darwin: 'readback', win32: 'handoff', other: 'handoff' }
  },
  'desktop.google_search': {
    classes: same('read'),
    verification: { darwin: 'handoff', win32: 'handoff', other: 'handoff' }
  },
  'desktop.open_x': {
    classes: same('reversible'),
    verification: { darwin: 'handoff', win32: 'handoff', other: 'handoff' }
  },
  // Photo Booth presses a shutter (creates a photo). Windows only opens Camera, which is reversible.
  'desktop.photo_booth_capture': {
    classes: { darwin: 'create', win32: 'reversible', other: null },
    verification: { darwin: 'handoff', win32: 'handoff', other: 'handoff' }
  }
}

export function isCatalogActionId(id: unknown): id is DesktopAdapterId {
  return typeof id === 'string' && (DESKTOP_ADAPTER_IDS as readonly string[]).includes(id)
}

export function voicePlatformOf(platform: NodeJS.Platform | string): VoicePlatform {
  return platform === 'darwin' || platform === 'win32' ? platform : 'other'
}

/**
 * The class of a request on a platform, or null when the platform cannot run it. Arc named on Windows is
 * unsupported even for Google search and X: no silent swap to another browser.
 */
export function classifyDesktopRequest(
  request: DesktopActionRequest,
  platform: VoicePlatform
): VoiceActionClass | null {
  if (platform === 'win32' && 'browser' in request.args && request.args.browser === 'arc') return null
  return CATALOG[request.id].classes[platform]
}

export function verificationFor(request: DesktopActionRequest, platform: VoicePlatform): VoiceVerification {
  return CATALOG[request.id].verification[platform]
}

/** What the confirmation card shows. Built here from templates and validated arguments, never from the transcript. */
export interface VoiceActionPreview {
  title: string
  argument?: string
}

export function previewFor(request: DesktopActionRequest, platform: VoicePlatform = 'darwin'): VoiceActionPreview {
  switch (request.id) {
    case 'desktop.open_notes':
      return { title: platform === 'win32' ? 'Open Sticky Notes' : 'Open Notes' }
    case 'desktop.create_note':
      return platform === 'win32'
        ? { title: 'Save a note as a text file', argument: request.args.title }
        : { title: 'Create a note in Notes', argument: request.args.title }
    case 'desktop.open_arc':
      return { title: 'Open Arc' }
    case 'desktop.google_search':
      return {
        title: request.args.browser === 'arc' ? 'Search Google in Arc' : 'Search Google',
        argument: request.args.q
      }
    case 'desktop.open_x':
      return { title: request.args.browser === 'arc' ? 'Open X in Arc' : 'Open X' }
    case 'desktop.photo_booth_capture':
      return { title: platform === 'win32' ? 'Open Camera' : 'Take a photo in Photo Booth' }
  }
}
