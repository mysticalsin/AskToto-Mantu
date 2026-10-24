import { z } from 'zod'

/**
 * Composer attachments (Métis 2.12 G54, CAP-28 / R059). Pure contract shared by main, preload and renderer.
 *
 * An attachment is something the owner dropped on, pasted into or picked for the composer. Main alone reads it: the
 * renderer sends an intent (the OS-provided drop paths, or just "picker" / "paste") and gets back ids, names, sizes and
 * refusal copy, never file contents. Each held attachment is bound to the conversation it was added to, and a send to
 * any other target is refused out loud instead of going to the wrong place.
 */

/** PROPOSED (G54, awaiting owner confirmation): at most this many files per turn. */
export const ATTACHMENT_MAX_FILES = 10
/** PROPOSED: the largest single file main will read. */
export const ATTACHMENT_MAX_FILE_BYTES = 25 * 1024 * 1024
/** PROPOSED: the largest total a single turn may carry. */
export const ATTACHMENT_MAX_TURN_BYTES = 50 * 1024 * 1024
/** PROPOSED: a turn carries one image at most (the ask has one image slot). */
export const ATTACHMENT_MAX_IMAGES = 1

/** Readable as text and quoted into the turn as a `document` record (data, never an instruction). */
export const ATTACHMENT_TEXT_EXTENSIONS = [
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'yaml',
  'yml',
  'log',
  'xml'
] as const
/** Read as a picture; checked against its magic bytes, not its name. */
export const ATTACHMENT_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const

export type AttachmentKind = 'text' | 'image'

export const ATTACHMENT_IPC = {
  add: 'attachments:add',
  remove: 'attachments:remove',
  list: 'attachments:list'
} as const

const KeySchema = z.string().min(1).max(64)
const AttachmentIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/)

/** Where the owner's conversation is, as the renderer sees it. Main combines it with its own owner and session. */
export const ConversationKeySchema = KeySchema

/**
 * One owner gesture. `drop` carries only what the OS gave the drop event; `picker` and `paste` carry nothing: main
 * opens its own dialog or reads the clipboard itself.
 */
export const AttachmentIntentSchema = z.discriminatedUnion('source', [
  z
    .object({
      source: z.literal('drop'),
      conversationKey: ConversationKeySchema,
      paths: z
        .array(z.string().min(1).max(4096))
        .min(1)
        .max(ATTACHMENT_MAX_FILES * 2)
    })
    .strict(),
  z.object({ source: z.literal('picker'), conversationKey: ConversationKeySchema }).strict(),
  z.object({ source: z.literal('paste'), conversationKey: ConversationKeySchema }).strict()
])
export type AttachmentIntent = z.infer<typeof AttachmentIntentSchema>

export const AttachmentRemoveSchema = z.object({ id: AttachmentIdSchema }).strict()
export const AttachmentListSchema = z.object({ conversationKey: ConversationKeySchema }).strict()

/** The ids a send names, and the conversation the renderer believes it is sending to. */
export const AttachmentSendFieldsSchema = {
  attachmentIds: z.array(AttachmentIdSchema).max(ATTACHMENT_MAX_FILES).optional(),
  attachmentConversationKey: ConversationKeySchema.optional()
}

export const ATTACHMENT_REFUSALS = [
  'unsupported-type',
  'too-large',
  'empty',
  'not-a-file',
  'symlink',
  'executable',
  'protected-location',
  'unreadable',
  'too-many',
  'turn-too-large',
  'too-many-images',
  'not-an-image',
  'nothing-to-paste',
  'cancelled',
  'signed-out',
  'invalid'
] as const
export type AttachmentRefusal = (typeof ATTACHMENT_REFUSALS)[number]

/** Why a held attachment could not go with a send. */
export type AttachmentSendFailure = 'wrong-target' | 'signed-out' | 'not-found' | 'image-slot-taken'

export const MIB = 1024 * 1024
const mib = (n: number): string => `${Math.round(n / MIB)} MB`

/** Honest per-file copy. No path, no content; the file name is the owner's own and is shown back to them. */
export function attachmentRefusalCopy(reason: AttachmentRefusal, name?: string): string {
  const file = name ? `"${name}"` : 'This file'
  switch (reason) {
    case 'unsupported-type':
      return `${file} is a type Métis cannot read yet. Text files and images work.`
    case 'too-large':
      return `${file} is larger than ${mib(ATTACHMENT_MAX_FILE_BYTES)}.`
    case 'empty':
      return `${file} is empty.`
    case 'not-a-file':
      return `${file} is a folder or not a regular file.`
    case 'symlink':
      return `${file} is a shortcut to another location. Attach the original file.`
    case 'executable':
      return `${file} is a program, so Métis will not attach it.`
    case 'protected-location':
      return `${file} is in a protected location, so Métis will not attach it.`
    case 'unreadable':
      return `${file} could not be read.`
    case 'too-many':
      return `Only ${ATTACHMENT_MAX_FILES} files fit in one question. ${file} was left out.`
    case 'turn-too-large':
      return `${file} would take this question past ${mib(ATTACHMENT_MAX_TURN_BYTES)}.`
    case 'too-many-images':
      return `One image fits in a question. ${file} was left out.`
    case 'not-an-image':
      return `${file} is not a valid image.`
    case 'nothing-to-paste':
      return 'The clipboard has no file or image to attach.'
    case 'cancelled':
      return 'No file was chosen.'
    case 'signed-out':
      return 'Sign in to attach files.'
    case 'invalid':
      return 'That attachment request was not valid.'
  }
}

export const ATTACHMENT_WRONG_TARGET_COPY = 'This file was attached to another conversation. Attach it again here.'
export const ATTACHMENT_NOT_FOUND_COPY = 'An attached file is no longer available. Attach it again.'
export const ATTACHMENT_SIGNED_OUT_COPY = 'Sign in to send attached files.'

export const ATTACHMENT_IMAGE_SLOT_COPY =
  'This question already has a screenshot. Remove the attached image or the screenshot.'

export function attachmentSendFailureCopy(reason: AttachmentSendFailure): string {
  switch (reason) {
    case 'wrong-target':
      return ATTACHMENT_WRONG_TARGET_COPY
    case 'signed-out':
      return ATTACHMENT_SIGNED_OUT_COPY
    case 'image-slot-taken':
      return ATTACHMENT_IMAGE_SLOT_COPY
    case 'not-found':
      return ATTACHMENT_NOT_FOUND_COPY
  }
}

/** What the renderer may know about a held attachment. Never its text or its path. */
export const AttachmentViewSchema = z
  .object({
    id: AttachmentIdSchema,
    name: z.string().max(255),
    kind: z.enum(['text', 'image']),
    bytes: z.number().int().nonnegative(),
    conversationKey: KeySchema,
    addedAt: z.number().int().nonnegative()
  })
  .strict()
export type AttachmentView = z.infer<typeof AttachmentViewSchema>

export interface AttachmentRejection {
  name: string
  reason: AttachmentRefusal
  message: string
}

export interface AttachmentAddResult {
  ok: boolean
  attachments: AttachmentView[]
  rejected: AttachmentRejection[]
}

export interface AttachmentListResult {
  attachments: AttachmentView[]
}

/** The only main-process error a send raises for attachments; its message is already owner-safe copy. */
export class AttachmentSendError extends Error {
  readonly reason: AttachmentSendFailure
  constructor(reason: AttachmentSendFailure) {
    super(attachmentSendFailureCopy(reason))
    this.name = 'AttachmentSendError'
    this.reason = reason
  }
}
