import { useSyncExternalStore } from 'react'
import type { AttachmentAddResult, AttachmentView } from '@shared/attachments'

/**
 * The composer's attachments (G54, CAP-28). Main holds the files; this keeps only what main said about them (ids, names,
 * sizes) and the honest refusal copy for what it turned away. Nothing here reads a file or sends a path other than the
 * ones the OS gave a drop event (resolved in preload).
 *
 * The conversation key names the conversation the composer is showing. Main binds every file to it together with the
 * owner and the live session, and refuses a send under any other.
 */
export interface ComposerAttachmentsState {
  items: AttachmentView[]
  errors: string[]
  busy: boolean
}

export interface ComposerAttachmentsApi {
  attachDroppedFiles(key: string, files: File[]): Promise<AttachmentAddResult>
  attachFromPicker(key: string): Promise<AttachmentAddResult>
  attachFromClipboard(key: string): Promise<AttachmentAddResult>
  removeAttachment(id: string): Promise<{ ok: boolean }>
  listAttachments(key: string): Promise<{ attachments: AttachmentView[] }>
}

const EMPTY: ComposerAttachmentsState = { items: [], errors: [], busy: false }

export function createComposerAttachments(getApi: () => ComposerAttachmentsApi | undefined, initialKey = 'dock') {
  let state = EMPTY
  let key = initialKey
  const listeners = new Set<() => void>()
  const set = (next: ComposerAttachmentsState): void => {
    state = next
    for (const l of listeners) l()
  }

  const apply = (r: AttachmentAddResult, forKey: string): void => {
    if (forKey !== key) return // the owner moved to another conversation while main was reading
    const known = new Set(state.items.map((i) => i.id))
    const added = r.attachments.filter((a) => !known.has(a.id))
    // A cancelled picker is not an error worth showing.
    const errors = r.rejected.filter((x) => x.reason !== 'cancelled').map((x) => x.message)
    set({ items: [...state.items, ...added], errors, busy: false })
  }

  const run = async (call: (api: ComposerAttachmentsApi, k: string) => Promise<AttachmentAddResult>): Promise<void> => {
    const api = getApi()
    if (!api) return
    const forKey = key
    set({ ...state, busy: true, errors: [] })
    try {
      apply(await call(api, forKey), forKey)
    } catch {
      set({ ...state, busy: false, errors: ['That file could not be attached.'] })
    }
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: (): ComposerAttachmentsState => state,
    conversationKey: (): string => key,
    /** The owner is now in another conversation: what was attached to the old one is not carried over. */
    setConversation(next: string): void {
      if (next === key) return
      key = next
      set(EMPTY)
    },
    attachDropped: (files: File[]) => run((api, k) => api.attachDroppedFiles(k, files)),
    pick: () => run((api, k) => api.attachFromPicker(k)),
    paste: () => run((api, k) => api.attachFromClipboard(k)),
    async remove(id: string): Promise<void> {
      set({ ...state, items: state.items.filter((i) => i.id !== id), errors: [] })
      await getApi()?.removeAttachment(id)
    },
    dismissErrors: (): void => set({ ...state, errors: [] }),
    /** Re-reads what main still holds for this conversation (a refused send may have discarded files). */
    async refresh(): Promise<void> {
      const api = getApi()
      if (!api) return
      const forKey = key
      try {
        const r = await api.listAttachments(forKey)
        if (forKey === key) set({ ...state, items: r.attachments })
      } catch {
        /* keep what is shown; main still enforces every send */
      }
    },
    /**
     * Fields for one ask. The ids leave the composer with the send, so a file never rides a second question; if main
     * refuses the send (another conversation, signed out) it says so in the answer area and has dropped the file.
     */
    takeForSend(): { attachmentIds?: string[]; attachmentConversationKey?: string } {
      if (state.items.length === 0) return {}
      const ids = state.items.map((i) => i.id)
      set({ items: [], errors: [], busy: false })
      return { attachmentIds: ids, attachmentConversationKey: key }
    }
  }
}

export const composerAttachments = createComposerAttachments(() =>
  typeof window === 'undefined' ? undefined : (window.toto as unknown as ComposerAttachmentsApi | undefined)
)

export function useComposerAttachments(): ComposerAttachmentsState {
  return useSyncExternalStore(
    composerAttachments.subscribe,
    composerAttachments.getSnapshot,
    composerAttachments.getSnapshot
  )
}

/** True when the clipboard or drag carries something other than text: files or an image. Plain text paste stays text. */
export function carriesFiles(data: Pick<DataTransfer, 'files' | 'types'> | null | undefined): boolean {
  if (!data) return false
  return data.files.length > 0 || Array.from(data.types ?? []).includes('Files')
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
