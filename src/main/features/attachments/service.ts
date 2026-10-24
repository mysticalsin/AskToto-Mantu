import { randomUUID } from 'node:crypto'
import {
  attachmentRefusalCopy,
  ATTACHMENT_MAX_FILES,
  ATTACHMENT_MAX_IMAGES,
  ATTACHMENT_MAX_TURN_BYTES,
  type AttachmentAddResult,
  type AttachmentIntent,
  type AttachmentKind,
  type AttachmentRefusal,
  type AttachmentRejection,
  type AttachmentSendFailure,
  type AttachmentView
} from '@shared/attachments'
import { inspectBytes, inspectFile, type InspectResult } from './inspect'

/** What main read off the clipboard itself: file paths, or one image held in memory. */
export type ClipboardPayload = { paths: string[] } | { image: { name: string; data: Buffer } }

export interface AttachmentServiceDeps {
  /** The memory partition in force (the owner), or null while signed out. */
  owner(): string | null
  /** The main-owned id of the live session; a held file is bound to the one in force when it was added. */
  session(): string
  now?(): number
  newId?(): string
  /** Main's own open-file dialog. Null when the owner cancelled. */
  pickFiles(): Promise<string[] | null>
  /** Main's own read of the system clipboard. */
  readClipboard(): Promise<ClipboardPayload | null>
  /** Extra locations main never reads (its own data folder). */
  isProtectedPath?(path: string): boolean
}

export interface ConsumedAttachment {
  id: string
  name: string
  kind: AttachmentKind
  bytes: number
  data: Buffer
  mime?: string
}

export type ConsumeResult = { ok: true; items: ConsumedAttachment[] } | { ok: false; reason: AttachmentSendFailure }

export interface AttachmentService {
  add(intent: AttachmentIntent): Promise<AttachmentAddResult>
  list(conversationKey: string): AttachmentView[]
  remove(id: string): boolean
  /**
   * Takes the named files for one send. It succeeds only when every one is held, was added under the same owner,
   * session and conversation as this send, and (for an image) the turn has a free image slot. Anything else
   * consumes nothing, and a file that belongs to another target is discarded rather than kept for the wrong place.
   */
  consume(ids: readonly string[], conversationKey: string, opts: { imageSlotFree: boolean }): ConsumeResult
  clear(reason: string): void
}

interface Held {
  view: AttachmentView
  data: Buffer
  mime?: string
  owner: string
  session: string
}

export function createAttachmentService(deps: AttachmentServiceDeps): AttachmentService {
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? (() => randomUUID().replace(/-/g, '').slice(0, 24))
  const held = new Map<string, Held>()
  const protectedPath = deps.isProtectedPath ?? (() => false)

  const reject = (name: string, reason: AttachmentRefusal): AttachmentRejection => ({
    name,
    reason,
    message: attachmentRefusalCopy(reason, name)
  })

  /** Held files that belong to this owner, session and conversation: what one send could carry. */
  const heldFor = (owner: string, session: string, key: string): Held[] =>
    [...held.values()].filter((h) => h.owner === owner && h.session === session && h.view.conversationKey === key)

  const resolvePaths = async (
    intent: AttachmentIntent
  ): Promise<{ paths?: string[]; image?: { name: string; data: Buffer }; none?: AttachmentRefusal }> => {
    if (intent.source === 'drop') return { paths: intent.paths }
    if (intent.source === 'picker') {
      const paths = await deps.pickFiles()
      return paths && paths.length > 0 ? { paths } : { none: 'cancelled' }
    }
    const clip = await deps.readClipboard()
    if (!clip) return { none: 'nothing-to-paste' }
    if ('image' in clip) return { image: clip.image }
    return clip.paths.length > 0 ? { paths: clip.paths } : { none: 'nothing-to-paste' }
  }

  return {
    async add(intent) {
      const owner = deps.owner()
      if (owner === null) return { ok: false, attachments: [], rejected: [reject('', 'signed-out')] }
      const session = deps.session()
      const key = intent.conversationKey
      const source = await resolvePaths(intent)
      if (source.none) return { ok: false, attachments: [], rejected: [reject('', source.none)] }
      // The owner or the session may have changed while a dialog was open: the file is bound to the target in force now.
      if (deps.owner() !== owner || deps.session() !== session)
        return { ok: false, attachments: [], rejected: [reject('', 'cancelled')] }

      const attachments: AttachmentView[] = []
      const rejected: AttachmentRejection[] = []
      const existing = heldFor(owner, session, key)
      let count = existing.length
      let total = existing.reduce((sum, h) => sum + h.view.bytes, 0)
      let images = existing.filter((h) => h.view.kind === 'image').length

      const consider = (r: InspectResult): void => {
        if (!r.ok) return void rejected.push(reject(r.name, r.reason))
        if (count >= ATTACHMENT_MAX_FILES) return void rejected.push(reject(r.name, 'too-many'))
        if (r.kind === 'image' && images >= ATTACHMENT_MAX_IMAGES)
          return void rejected.push(reject(r.name, 'too-many-images'))
        if (total + r.bytes > ATTACHMENT_MAX_TURN_BYTES) return void rejected.push(reject(r.name, 'turn-too-large'))
        const view: AttachmentView = {
          id: newId(),
          name: r.name,
          kind: r.kind,
          bytes: r.bytes,
          conversationKey: key,
          addedAt: now()
        }
        held.set(view.id, { view, data: r.data, mime: r.mime, owner, session })
        attachments.push(view)
        count += 1
        total += r.bytes
        if (r.kind === 'image') images += 1
      }

      if (source.image) consider(inspectBytes(source.image.name.slice(0, 255), source.image.data))
      for (const path of source.paths ?? []) consider(await inspectFile(path, protectedPath))
      return { ok: attachments.length > 0, attachments, rejected }
    },

    list(conversationKey) {
      const owner = deps.owner()
      if (owner === null) return []
      return heldFor(owner, deps.session(), conversationKey).map((h) => h.view)
    },

    remove(id) {
      return held.delete(id)
    },

    consume(ids, conversationKey, opts) {
      if (ids.length === 0) return { ok: true, items: [] }
      const owner = deps.owner()
      const session = deps.session()
      const entries: Held[] = []
      let failure: AttachmentSendFailure | null = owner === null ? 'signed-out' : null
      for (const id of ids) {
        const h = held.get(id)
        if (!h) failure ??= 'not-found'
        else entries.push(h)
      }
      if (owner !== null) {
        for (const h of entries) {
          if (h.owner !== owner || h.session !== session || h.view.conversationKey !== conversationKey) {
            failure = 'wrong-target'
            break
          }
        }
      }
      if (failure === 'wrong-target') {
        // Never keep a file for the wrong place: what belonged to another target is dropped with the refusal.
        for (const h of entries)
          if (h.owner !== owner || h.session !== session || h.view.conversationKey !== conversationKey)
            held.delete(h.view.id)
        return { ok: false, reason: failure }
      }
      if (failure) return { ok: false, reason: failure }
      if (!opts.imageSlotFree && entries.some((h) => h.view.kind === 'image'))
        return { ok: false, reason: 'image-slot-taken' }
      for (const h of entries) held.delete(h.view.id)
      return {
        ok: true,
        items: entries.map((h) => ({
          id: h.view.id,
          name: h.view.name,
          kind: h.view.kind,
          bytes: h.view.bytes,
          data: h.data,
          mime: h.mime
        }))
      }
    },

    clear() {
      held.clear()
    }
  }
}
