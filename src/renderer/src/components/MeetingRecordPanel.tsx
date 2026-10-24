import { useCallback, useEffect, useState } from 'react'
import type { MeetingRecord, MeetingRecordEdit, RecordItem, RecordKind } from '@shared/meeting-record'
import { clock } from './review/review-format'

const SECTIONS: Array<{ kind: RecordKind; title: string }> = [
  { kind: 'decision', title: 'Decisions' },
  { kind: 'question', title: 'Open questions' },
  { kind: 'action', title: 'Actions' }
]

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
  const [draft, setDraft] = useState({ text: '', owner: '', dueText: '' })
  const [adding, setAdding] = useState<{ kind: RecordKind; text: string } | null>(null)
  if (record.status === 'unavailable') return null
  return (
    <section aria-label="Meeting record" className="flex flex-col gap-3">
      {SECTIONS.map(({ kind, title }) => {
        const items = record.items.filter((i) => i.kind === kind)
        return (
          <div key={kind}>
            <div className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
              <span>{title}</span>
              <button
                type="button"
                className="no-drag focus-ring rounded px-1 normal-case hover:text-[color:var(--color-ink-2)]"
                onClick={() => setAdding({ kind, text: '' })}
              >
                Add
              </button>
            </div>
            {items.length === 0 && adding?.kind !== kind ? (
              <div className="text-[12px] text-[color:var(--color-ink-3)]">None recorded.</div>
            ) : null}
            <ul className="flex flex-col gap-1.5">
              {items.map((item) => (
                <li key={item.id} className="text-[13px] leading-snug text-[color:var(--color-ink)]">
                  {editing === item.id ? (
                    <div className="flex flex-col gap-1">
                      <textarea
                        aria-label="Text"
                        className="no-drag focus-ring w-full rounded-md bg-white/[0.04] p-1.5 text-[13px]"
                        value={draft.text}
                        onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                      />
                      {item.kind === 'action' && (
                        <div className="flex gap-1">
                          <input
                            aria-label="Owner"
                            placeholder="Owner"
                            className="no-drag focus-ring min-w-0 flex-1 rounded-md bg-white/[0.04] p-1 text-[12px]"
                            value={draft.owner}
                            onChange={(e) => setDraft({ ...draft, owner: e.target.value })}
                          />
                          <input
                            aria-label="Due"
                            placeholder="Due"
                            className="no-drag focus-ring min-w-0 flex-1 rounded-md bg-white/[0.04] p-1 text-[12px]"
                            value={draft.dueText}
                            onChange={(e) => setDraft({ ...draft, dueText: e.target.value })}
                          />
                        </div>
                      )}
                      <div className="flex gap-2 text-[11px]">
                        <button
                          type="button"
                          className="no-drag focus-ring"
                          onClick={() => {
                            onSet(item, draft)
                            setEditing(null)
                          }}
                        >
                          Save
                        </button>
                        <button type="button" className="no-drag focus-ring" onClick={() => setEditing(null)}>
                          Cancel
                        </button>
                      </div>
                    </div>
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
                          className="no-drag focus-ring"
                          onClick={() => {
                            setDraft({ text: item.text, owner: item.owner ?? '', dueText: item.dueText ?? '' })
                            setEditing(item.id)
                          }}
                        >
                          Edit
                        </button>
                        <button type="button" className="no-drag focus-ring" onClick={() => onDelete(item)}>
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
                  className="no-drag focus-ring min-w-0 flex-1 rounded-md bg-white/[0.04] p-1 text-[13px]"
                  value={adding.text}
                  onChange={(e) => setAdding({ kind, text: e.target.value })}
                />
                <button
                  type="button"
                  className="no-drag focus-ring text-[11px]"
                  onClick={() => {
                    if (adding.text.trim()) onAdd(kind, adding.text.trim())
                    setAdding(null)
                  }}
                >
                  Save
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
