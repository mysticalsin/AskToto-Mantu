import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { MeetingRecord, MeetingRecordEdit, RecordItem, RecordKind } from '@shared/meeting-record'
import { clock } from './review/review-format'

const SECTIONS: Array<{ kind: RecordKind; title: string; singular: string }> = [
  { kind: 'decision', title: 'Decisions', singular: 'decision' },
  { kind: 'question', title: 'Open questions', singular: 'open question' },
  { kind: 'action', title: 'Actions', singular: 'action' }
]

type Draft = { text: string; owner: string; dueText: string }

/** "lines 12–14 · 04:31": 1-based line numbers, and the time formatted exactly as the transcript view does. */
export function citationLabel(item: RecordItem): string {
  const c = item.citation
  if (!c) return 'No transcript source'
  const lines = c.fromLine === c.toLine ? `line ${c.fromLine + 1}` : `lines ${c.fromLine + 1}–${c.toLine + 1}`
  return `${lines} · ${clock(c.fromT)}`
}

/** The edit the bridge receives when the owner changes text, owner or due. Only changed fields are sent. */
export function setOp(
  file: string,
  item: RecordItem,
  patch: { text: string; owner: string; dueText: string }
): MeetingRecordEdit {
  const op: MeetingRecordEdit = { file, op: 'set', id: item.id }
  if (patch.text.trim() && patch.text.trim() !== item.text) op.text = patch.text.trim()
  if (item.kind === 'action') {
    if ((patch.owner.trim() || null) !== item.owner) op.owner = patch.owner.trim() || null
    if ((patch.dueText.trim() || null) !== item.dueText) op.dueText = patch.dueText.trim() || null
  }
  return op
}

/** Item text inside a button name: long enough to tell rows apart, short enough to hear. */
function labelText(text: string): string {
  return text.length > 60 ? `${text.slice(0, 59)}…` : text
}

/**
 * Keys in an edit or add field: Escape cancels; Enter saves a single-line field, while a multiline field needs
 * Cmd/Ctrl+Enter so Enter can still break a line. Keys pressed while an IME is composing are never taken.
 */
export function recordEditKey(
  e: { key: string; isComposing?: boolean; shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean },
  multiline: boolean
): 'save' | 'cancel' | null {
  if (e.isComposing) return null
  if (e.key === 'Escape') return 'cancel'
  if (e.key !== 'Enter' || e.shiftKey) return null
  if (multiline) return e.metaKey || e.ctrlKey ? 'save' : null
  return 'save'
}

const keyOf = (e: KeyboardEvent): Parameters<typeof recordEditKey>[0] => ({
  key: e.key,
  isComposing: e.nativeEvent.isComposing,
  shiftKey: e.shiftKey,
  metaKey: e.metaKey,
  ctrlKey: e.ctrlKey
})

export function RecordItemEditor({
  item,
  draft,
  onDraft,
  onSave,
  onCancel
}: {
  item: RecordItem
  draft: Draft
  onDraft(draft: Draft): void
  onSave(): void
  onCancel(): void
}): JSX.Element {
  const keys =
    (multiline: boolean) =>
    (e: KeyboardEvent): void => {
      const act = recordEditKey(keyOf(e), multiline)
      if (!act) return
      e.preventDefault()
      e.stopPropagation()
      if (act === 'save') onSave()
      else onCancel()
    }
  return (
    <div className="flex flex-col gap-1">
      <textarea
        aria-label="Text"
        autoFocus
        className="no-drag focus-ring w-full rounded-md bg-white/[0.04] p-1.5 text-[13px]"
        value={draft.text}
        onKeyDown={keys(true)}
        onChange={(e) => onDraft({ ...draft, text: e.target.value })}
      />
      {item.kind === 'action' && (
        <div className="flex gap-1">
          <input
            aria-label="Owner"
            placeholder="Owner"
            className="no-drag focus-ring min-w-0 flex-1 rounded-md bg-white/[0.04] p-1 text-[12px]"
            value={draft.owner}
            onKeyDown={keys(false)}
            onChange={(e) => onDraft({ ...draft, owner: e.target.value })}
          />
          <input
            aria-label="Due"
            placeholder="Due"
            className="no-drag focus-ring min-w-0 flex-1 rounded-md bg-white/[0.04] p-1 text-[12px]"
            value={draft.dueText}
            onKeyDown={keys(false)}
            onChange={(e) => onDraft({ ...draft, dueText: e.target.value })}
          />
        </div>
      )}
      <div className="flex gap-2 text-[11px]">
        <button type="button" aria-label="Save edit" className="no-drag focus-ring" onClick={onSave}>
          Save
        </button>
        <button type="button" aria-label="Cancel edit" className="no-drag focus-ring" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

export function MeetingRecordList({
  record,
  onJump,
  onSet,
  onDelete,
  onAdd
}: {
  record: MeetingRecord
  onJump(item: RecordItem): void
  onSet(item: RecordItem, patch: { text: string; owner: string; dueText: string }): void
  onDelete(item: RecordItem): void
  onAdd(kind: RecordKind, text: string): void
}): JSX.Element | null {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>({ text: '', owner: '', dueText: '' })
  const [adding, setAdding] = useState<{ kind: RecordKind; text: string } | null>(null)
  const baseId = useId()
  // Where focus goes once an edit or add row closes, so a keyboard user is never dropped to the page body.
  const returnTo = useRef<string | null>(null)
  const controls = useRef(new Map<string, HTMLButtonElement>())
  const keep = (key: string) => (el: HTMLButtonElement | null) => {
    if (el) controls.current.set(key, el)
    else controls.current.delete(key)
  }
  useEffect(() => {
    if (editing !== null || adding !== null || !returnTo.current) return
    controls.current.get(returnTo.current)?.focus()
    returnTo.current = null
  }, [editing, adding])
  if (record.status === 'unavailable') return null
  const closeEdit = (item: RecordItem): void => {
    returnTo.current = `edit:${item.id}`
    setEditing(null)
  }
  const closeAdd = (kind: RecordKind, save: boolean): void => {
    if (save && adding?.text.trim()) onAdd(kind, adding.text.trim())
    returnTo.current = `add:${kind}`
    setAdding(null)
  }
  return (
    <section aria-label="Meeting record" className="flex flex-col gap-3">
      {SECTIONS.map(({ kind, title, singular }) => {
        const items = record.items.filter((i) => i.kind === kind)
        const headingId = `${baseId}-${kind}`
        return (
          <div key={kind}>
            <div className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
              <h3 id={headingId} className="m-0 text-[11px] font-semibold">
                {title}
              </h3>
              <button
                type="button"
                ref={keep(`add:${kind}`)}
                aria-label={`Add ${singular}`}
                className="no-drag focus-ring rounded px-1 normal-case hover:text-[color:var(--color-ink-2)]"
                onClick={() => setAdding({ kind, text: '' })}
              >
                Add
              </button>
            </div>
            {items.length === 0 && adding?.kind !== kind ? (
              <div className="text-[12px] text-[color:var(--color-ink-3)]">None recorded.</div>
            ) : null}
            <ul aria-labelledby={headingId} className="flex flex-col gap-1.5">
              {items.map((item) => (
                <li key={item.id} className="text-[13px] leading-snug text-[color:var(--color-ink)]">
                  {editing === item.id ? (
                    <RecordItemEditor
                      item={item}
                      draft={draft}
                      onDraft={setDraft}
                      onSave={() => {
                        onSet(item, draft)
                        closeEdit(item)
                      }}
                      onCancel={() => closeEdit(item)}
                    />
                  ) : (
                    <>
                      <span>{item.text}</span>
                      {item.kind === 'action' && (item.owner || item.dueText) ? (
                        <span className="ml-1 text-[12px] text-[color:var(--color-ink-2)]">
                          {[item.owner, item.dueText].filter(Boolean).join(' · ')}
                        </span>
                      ) : null}
                      {item.source === 'user' ? (
                        <span className="ml-1 text-[10px] text-[color:var(--color-ink-3)]">edited</span>
                      ) : null}
                      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[color:var(--color-ink-3)]">
                        {item.citation ? (
                          <button
                            type="button"
                            className="no-drag focus-ring rounded-full bg-white/[0.06] px-1.5 py-0.5 hover:text-[color:var(--color-ink-2)]"
                            onClick={() => onJump(item)}
                          >
                            {citationLabel(item)}
                          </button>
                        ) : (
                          <span>{citationLabel(item)}</span>
                        )}
                        <button
                          type="button"
                          ref={keep(`edit:${item.id}`)}
                          aria-label={`Edit: ${labelText(item.text)}`}
                          className="no-drag focus-ring"
                          onClick={() => {
                            setDraft({ text: item.text, owner: item.owner ?? '', dueText: item.dueText ?? '' })
                            setEditing(item.id)
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete: ${labelText(item.text)}`}
                          className="no-drag focus-ring"
                          onClick={() => {
                            // The row unmounts after the reload; its section's Add button keeps focus in the panel.
                            controls.current.get(`add:${kind}`)?.focus()
                            onDelete(item)
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
            {adding?.kind === kind ? (
              <div className="mt-1 flex gap-1">
                <input
                  aria-label={`Add to ${title}`}
                  autoFocus
                  className="no-drag focus-ring min-w-0 flex-1 rounded-md bg-white/[0.04] p-1 text-[13px]"
                  value={adding.text}
                  onKeyDown={(e) => {
                    const act = recordEditKey(keyOf(e), false)
                    if (!act) return
                    e.preventDefault()
                    e.stopPropagation()
                    closeAdd(kind, act === 'save')
                  }}
                  onChange={(e) => setAdding({ kind, text: e.target.value })}
                />
                <button
                  type="button"
                  aria-label={`Save new ${singular}`}
                  className="no-drag focus-ring text-[11px]"
                  onClick={() => closeAdd(kind, true)}
                >
                  Save
                </button>
                <button
                  type="button"
                  aria-label={`Cancel new ${singular}`}
                  className="no-drag focus-ring text-[11px]"
                  onClick={() => closeAdd(kind, false)}
                >
                  Cancel
                </button>
              </div>
            ) : null}
          </div>
        )
      })}
    </section>
  )
}

/** The saved-meeting record: decisions, open questions and actions with transcript citations the owner can correct. */
export function MeetingRecordPanel({
  file,
  onJump
}: {
  file: string
  onJump(item: RecordItem): void
}): JSX.Element | null {
  const [record, setRecord] = useState<MeetingRecord | null>(null)
  const load = useCallback(async () => {
    try {
      setRecord((await window.toto?.meetingRecord?.get(file)) ?? null)
    } catch {
      setRecord(null)
    }
  }, [file])
  useEffect(() => {
    void load()
  }, [load])
  const send = useCallback(
    async (op: MeetingRecordEdit) => {
      try {
        await window.toto?.meetingRecord?.edit(op)
      } finally {
        await load()
      }
    },
    [load]
  )
  if (!record) return null
  return (
    <MeetingRecordList
      record={record}
      onJump={onJump}
      onSet={(item, patch) => void send(setOp(file, item, patch))}
      onDelete={(item) => void send({ file, op: 'delete', id: item.id })}
      onAdd={(kind, text) => void send({ file, op: 'add', kind, text })}
    />
  )
}
