/**
 * New-routine editor (G69, CAP-31): fill the form, Preview (main compiles it), then a consent card that shows exactly
 * what will run. Create echoes main's proposal id and preview hash; nothing is created without that card.
 */
import { useEffect, useId, useState } from 'react'
import {
  ROUTINE_PURPOSES,
  ROUTINE_TITLE_MAX_CHARS,
  ROUTINE_TOOLS,
  type CompileRequest,
  type ConsentResult
} from '@shared/routines'
import type { AssistantView } from '@shared/assistants'
import { ctl } from '../../ui/ctl'
import { createFromPreview, isPreviewExpired, type CompiledPreview, type RoutinesApi } from './routine-actions'
import {
  COMPILE_REFUSAL_COPY,
  CONSENT_REFUSAL_COPY,
  PURPOSE_COPY,
  TOOL_COPY,
  consentKindCopy,
  formatWhen
} from './routine-copy'

const primaryBtn =
  'no-drag cl-focus min-h-[28px] rounded-md bg-[var(--cl-primary)] px-3 text-[12px] font-medium text-[color:var(--cl-primary-foreground)] disabled:opacity-40'
const quietBtn =
  'no-drag cl-focus min-h-[28px] rounded-md px-3 text-[12px] text-[color:var(--cl-muted-foreground)] hover:bg-white/10 hover:text-[color:var(--cl-foreground)] disabled:opacity-40'

/** The consent card: main's preview copy, up to three next runs, tools, and Runs once or Repeats. */
export function ConsentCard({
  compiled,
  now,
  busy,
  onCreate,
  onBack
}: {
  compiled: CompiledPreview
  now: number
  busy: boolean
  onCreate: () => void
  onBack: () => void
}): JSX.Element {
  const { preview } = compiled
  const expired = isPreviewExpired(compiled, now)
  const headingId = useId()
  return (
    <div
      role="group"
      aria-labelledby={headingId}
      className="flex flex-col gap-2 rounded-[var(--cl-radius)] border border-[var(--cl-border)] px-3 py-3"
    >
      <div id={headingId} className="text-[13px] font-semibold text-[color:var(--cl-foreground)]">
        {preview.title}
      </div>
      <div className="text-[12px] text-[color:var(--cl-foreground)]">{preview.copy}</div>
      <div className="text-[12px] text-[color:var(--cl-muted-foreground)]">
        {PURPOSE_COPY[preview.purpose]} · {consentKindCopy(preview.consentKind)}
      </div>
      <div className="text-[12px] text-[color:var(--cl-muted-foreground)]">
        Next runs:
        <ul className="mt-1 list-none pl-0">
          {preview.nextRuns.slice(0, 3).map((at) => (
            <li key={at}>{formatWhen(at)}</li>
          ))}
        </ul>
      </div>
      <div className="text-[12px] text-[color:var(--cl-muted-foreground)]">
        Tools: {preview.tools.length > 0 ? preview.tools.map((t) => TOOL_COPY[t]).join(', ') : 'None'}
      </div>
      {expired && (
        <div role="status" className="text-[12px] text-[color:var(--cl-foreground)]">
          Preview expired. Preview again.
        </div>
      )}
      <div className="flex gap-2">
        <button type="button" className={primaryBtn} disabled={expired || busy} onClick={onCreate}>
          Create
        </button>
        <button type="button" className={quietBtn} onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  )
}

type EditorState =
  | { kind: 'form' }
  | { kind: 'compiling' }
  | { kind: 'previewing'; compiled: CompiledPreview }
  | { kind: 'consenting'; compiled: CompiledPreview }

export function RoutineEditor({
  api,
  onCreated,
  onClose
}: {
  api: RoutinesApi
  onCreated: (result: Extract<ConsentResult, { ok: true }>) => void
  onClose: () => void
}): JSX.Element {
  const [assistants, setAssistants] = useState<AssistantView[] | null>(null)
  const [assistantId, setAssistantId] = useState('')
  const [purpose, setPurpose] = useState<CompileRequest['purpose']>('reminder')
  const [title, setTitle] = useState('')
  const [phrase, setPhrase] = useState('')
  const [consentKind, setConsentKind] = useState<CompileRequest['consentKind']>('recurring')
  const [tools, setTools] = useState<Array<(typeof ROUTINE_TOOLS)[number]>>([])
  const [state, setState] = useState<EditorState>({ kind: 'form' })
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const fieldId = useId()

  useEffect(() => {
    let live = true
    void window.toto.assistants
      .list()
      .then((result) => {
        if (!live) return
        const usable = result.ok ? result.assistants.filter((a) => !a.archived) : []
        setAssistants(usable)
        if (usable[0]) setAssistantId((current) => current || usable[0]!.assistantId)
      })
      .catch(() => live && setAssistants([]))
    return () => {
      live = false
    }
  }, [])

  // Re-evaluate preview expiry while the consent card is open.
  const previewing = state.kind === 'previewing'
  useEffect(() => {
    if (!previewing) return
    const timer = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(timer)
  }, [previewing])

  const canPreview = assistantId !== '' && title.trim() !== '' && phrase.trim() !== '' && state.kind !== 'compiling'

  const preview = async (): Promise<void> => {
    setError(null)
    setState({ kind: 'compiling' })
    const request: CompileRequest = {
      assistantId,
      purpose,
      title: title.trim(),
      consentKind,
      phrase: phrase.trim(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...(tools.length > 0 ? { tools } : {})
    }
    const result = await api.compile(request)
    setNow(Date.now())
    if (result.ok) setState({ kind: 'previewing', compiled: result })
    else {
      setError(COMPILE_REFUSAL_COPY[result.reason])
      setState({ kind: 'form' })
    }
  }

  const create = async (compiled: CompiledPreview): Promise<void> => {
    setState({ kind: 'consenting', compiled })
    const result = await createFromPreview(api, compiled, Date.now())
    if (result.ok) onCreated(result)
    else {
      setError(CONSENT_REFUSAL_COPY[result.reason])
      setState({ kind: 'previewing', compiled })
    }
  }

  if (state.kind === 'previewing' || state.kind === 'consenting') {
    const compiled = state.compiled
    return (
      <div className="flex flex-col gap-2">
        <ConsentCard
          compiled={compiled}
          now={now}
          busy={state.kind === 'consenting'}
          onCreate={() => void create(compiled)}
          onBack={() => setState({ kind: 'form' })}
        />
        {error && (
          <div role="alert" className="text-[12px] text-[color:var(--cl-foreground)]">
            {error}
          </div>
        )}
      </div>
    )
  }

  const label = 'text-[12px] text-[color:var(--cl-muted-foreground)]'
  return (
    <form
      className="flex flex-col gap-2.5"
      aria-label="New routine"
      onSubmit={(event) => {
        event.preventDefault()
        if (canPreview) void preview()
      }}
    >
      <label className="flex flex-col gap-1" htmlFor={`${fieldId}-assistant`}>
        <span className={label}>Assistant</span>
        <select
          id={`${fieldId}-assistant`}
          className={ctl}
          value={assistantId}
          onChange={(e) => setAssistantId(e.target.value)}
          disabled={!assistants || assistants.length === 0}
        >
          {(assistants ?? []).map((a) => (
            <option key={a.assistantId} value={a.assistantId}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      {assistants && assistants.length === 0 && <div className={label}>Create an assistant first.</div>}
      <fieldset className="flex flex-wrap gap-3">
        <legend className={label}>Purpose</legend>
        {ROUTINE_PURPOSES.map((p) => (
          <label
            key={p}
            className="flex min-h-[28px] items-center gap-1.5 text-[12px] text-[color:var(--cl-foreground)]"
          >
            <input type="radio" name={`${fieldId}-purpose`} checked={purpose === p} onChange={() => setPurpose(p)} />
            {PURPOSE_COPY[p]}
          </label>
        ))}
      </fieldset>
      <label className="flex flex-col gap-1" htmlFor={`${fieldId}-title`}>
        <span className={label}>Title</span>
        <input
          id={`${fieldId}-title`}
          className={ctl}
          maxLength={ROUTINE_TITLE_MAX_CHARS}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1" htmlFor={`${fieldId}-when`}>
        <span className={label}>When</span>
        <input
          id={`${fieldId}-when`}
          className={ctl}
          maxLength={120}
          placeholder="every weekday at 9am"
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
        />
      </label>
      <fieldset className="flex flex-wrap gap-3">
        <legend className={label}>Repeat</legend>
        {(['once', 'recurring'] as const).map((kind) => (
          <label
            key={kind}
            className="flex min-h-[28px] items-center gap-1.5 text-[12px] text-[color:var(--cl-foreground)]"
          >
            <input
              type="radio"
              name={`${fieldId}-repeat`}
              checked={consentKind === kind}
              onChange={() => setConsentKind(kind)}
            />
            {kind === 'once' ? 'Just once' : 'Repeat'}
          </label>
        ))}
      </fieldset>
      <fieldset className="flex flex-wrap gap-3">
        <legend className={label}>Tools (optional)</legend>
        {ROUTINE_TOOLS.map((tool) => (
          <label
            key={tool}
            className="flex min-h-[28px] items-center gap-1.5 text-[12px] text-[color:var(--cl-foreground)]"
          >
            <input
              type="checkbox"
              checked={tools.includes(tool)}
              onChange={(e) =>
                setTools((current) => (e.target.checked ? [...current, tool] : current.filter((t) => t !== tool)))
              }
            />
            {TOOL_COPY[tool]}
          </label>
        ))}
      </fieldset>
      {error && (
        <div role="alert" className="text-[12px] text-[color:var(--cl-foreground)]">
          {error}
        </div>
      )}
      <div className="flex gap-2">
        <button type="submit" className={primaryBtn} disabled={!canPreview}>
          {state.kind === 'compiling' ? 'Previewing' : 'Preview'}
        </button>
        <button type="button" className={quietBtn} onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  )
}
