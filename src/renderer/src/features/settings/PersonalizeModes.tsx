import { useEffect, useId, useRef, useState } from 'react'
import { CircleCheck, FileText, MoreHorizontal, Plus, RotateCcw, Sparkles, Trash, Upload, Wand2 } from 'lucide-react'
import type { ConversationMode, CustomMode, PublicSettings } from '@shared/ipc'
import { BUILTIN_MODE_LABELS, MODE_GROUPS, modeLabel } from '@shared/ipc'
import { DEFAULT_MODE_PROMPTS } from '@shared/prompts'
import { modeSkillLock } from '@shared/mode-skills'
import { LazyInput, LazyTextarea } from '../../ui/LazyText'
import { ManagedChip } from '../../ui/ManagedChip'
import { Section } from '../../ui/Section'
import { ctl } from '../../ui/ctl'

/** Editable, pre-filled system prompt for the selected default mode. Plug-and-play with reset. */
function ModePromptEditor({
  settings,
  patch,
  mode,
  modeDisplayLabel
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
  mode: ConversationMode
  modeDisplayLabel?: string
}): JSX.Element {
  const isBuiltin = mode in BUILTIN_MODE_LABELS
  const override = settings.modePrompts[mode]
  const defaultPrompt = isBuiltin ? DEFAULT_MODE_PROMPTS[mode as keyof typeof DEFAULT_MODE_PROMPTS] ?? '' : ''
  const value = override && override.trim() !== '' ? override : defaultPrompt
  const isModified = !!override && override.trim() !== '' && override !== defaultPrompt
  const locked = settings.managedKeys.includes('modePrompts')
  const reset = (): void => {
    const m = { ...settings.modePrompts }
    delete m[mode]
    patch({ modePrompts: m })
  }
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[12px] font-medium text-[color:var(--cl-muted-foreground)]">
        {modeDisplayLabel ? `${modeDisplayLabel} prompt` : 'Mode prompt'}
      </label>
      <LazyTextarea
        value={value}
        disabled={locked}
        placeholder={isBuiltin ? 'Customize this mode’s system prompt…' : 'Write a system prompt for this mode…'}
        onCommit={(v) => patch({ modePrompts: { ...settings.modePrompts, [mode]: v } })}
        className={[ctl, 'h-44 w-full resize-none text-[12px] leading-relaxed', locked ? 'opacity-60' : ''].join(' ')}
      />
      <div className="flex items-center gap-3">
        {isBuiltin && (
          isModified ? (
            <button
              type="button"
              onClick={reset}
              disabled={locked}
              className="no-drag cl-focus inline-flex items-center gap-1 text-[12px] text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-foreground)]"
            >
              <RotateCcw size={12} /> Reset to default
            </button>
          ) : (
            <span className="text-[11px] text-[color:var(--cl-muted-foreground)]">Using the built-in default.</span>
          )
        )}
        <ManagedChip keys={settings.managedKeys} k="modePrompts" />
      </div>
      {isBuiltin && (
        <p className="m-0 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
          Operator skill v{modeSkillLock().skills[mode]?.version ?? 'unknown'} is locked to this Métis
          build. Your prompt above still applies. The skill runs in the background and cannot be
          edited, deleted, or overridden here. Ask answers also run locked caveman v
          {modeSkillLock().skills.caveman?.version ?? 'unknown'} (default full). Say stop caveman or
          normal mode to drop it. /caveman lite|full|ultra switches intensity. That skill cannot be
          edited here.
        </p>
      )}
    </div>
  )
}

const TEXT_FILE_RE = /\.(txt|md|markdown|csv|tsv|json|log|ya?ml|xml|html?|css|tsx?|jsx?|py|rb|go|rs|java|sql|sh)$/i

/** Cluely-style "add files for context" — reads text on-device and folds it into every answer. */
function ContextDocs({
  settings,
  patch,
  mode,
  modeDisplayLabel
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
  mode: ConversationMode
  modeDisplayLabel?: string
}): JSX.Element {
  const docs = settings.contextDocs[mode] || []
  const [drag, setDrag] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const inputId = useId()
  const writeDocs = (next: { name: string; text: string }[]): void =>
    patch({ contextDocs: { ...settings.contextDocs, [mode]: next } })

  const ingest = async (files: FileList | File[]): Promise<void> => {
    const added: { name: string; text: string }[] = []
    const skipped: string[] = []
    for (const f of Array.from(files)) {
      const isText = f.type.startsWith('text/') || TEXT_FILE_RE.test(f.name)
      if (!isText) {
        skipped.push(f.name)
        continue
      }
      if (f.size > 2_000_000) {
        skipped.push(`${f.name} (too big)`)
        continue
      }
      try {
        const text = await f.text()
        added.push({ name: f.name, text: text.slice(0, 120000) })
      } catch {
        skipped.push(f.name)
      }
    }
    const room = Math.max(0, 25 - docs.length)
    const kept = added.slice(0, room)
    const droppedForCap = added.length - kept.length
    if (kept.length) writeDocs([...docs, ...kept])
    const bits: string[] = []
    if (kept.length) bits.push(`Added ${kept.length} document${kept.length > 1 ? 's' : ''}.`)
    if (droppedForCap > 0) bits.push(`${droppedForCap} not added (25-document limit reached).`)
    if (skipped.length) bits.push(`Skipped (text files only, ≤2 MB): ${skipped.slice(0, 3).join(', ')}.`)
    if (!bits.length) bits.push('No text files found. Supported: txt, md, csv, json, code…')
    setNote(bits.join(' '))
  }

  const remove = (i: number): void => writeDocs(docs.filter((_, idx) => idx !== i))

  const contextTitle = modeDisplayLabel ? `Context documents · ${modeDisplayLabel}` : 'Context documents'
  return (
    <Section
      title={contextTitle}
      desc="Import what this mode should know: résumé, deck, brief, specs. Kept per-mode, read on-device."
    >
      <label
        htmlFor={inputId}
        onDragOver={(e) => {
          e.preventDefault()
          setDrag(true)
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDrag(false)
          if (e.dataTransfer.files.length) void ingest(e.dataTransfer.files)
        }}
        className={[
          'no-drag flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-[var(--cl-radius)] border border-dashed px-4 py-6 text-center transition-colors',
          drag
            ? 'border-[var(--cl-primary)] bg-[var(--cl-primary-soft)]'
            : 'border-[var(--cl-input)] bg-white/[0.02] hover:bg-white/[0.04]'
        ].join(' ')}
      >
        <Upload size={18} className="text-[color:var(--cl-primary)]" />
        <span className="text-[13px] text-[color:var(--cl-foreground)]">
          Add files for context
        </span>
        <span className="text-[12px] text-[color:var(--cl-muted-foreground)]">
          Drag &amp; drop files here to add them, or{' '}
          <button
            type="button"
            onClick={(e) => {
              // Stop the click from bubbling to the wrapping <label>, which would otherwise forward
              // its own synthetic click to the input and open the picker twice.
              e.preventDefault()
              e.stopPropagation()
              document.getElementById(inputId)?.click()
            }}
            className="no-drag cl-focus rounded text-[color:var(--cl-primary)] underline-offset-2 hover:underline"
          >
            Browse files
          </button>
        </span>
        <span className="text-[11px] text-[color:var(--cl-muted-foreground)]">
          Text files (txt, md, csv, json, code) up to 2 MB · 25 max
        </span>
        <input
          id={inputId}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => e.target.files && void ingest(e.target.files)}
        />
      </label>

      {note && <div className="mt-2 text-[11px] text-[color:var(--cl-muted-foreground)]">{note}</div>}

      {docs.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {docs.map((d, i) => (
            <div key={`${d.name}-${i}`} className="cl-card flex items-center gap-2 px-2.5 py-2">
              <FileText size={14} className="shrink-0 text-[color:var(--cl-primary)]" />
              <span className="min-w-0 flex-1 truncate text-[12px] text-[color:var(--cl-foreground)]" title={d.name}>
                {d.name}
              </span>
              <span className="shrink-0 text-[10px] text-[color:var(--cl-muted-foreground)]">
                {(d.text.length / 1000).toFixed(1)}k chars
              </span>
              <button
                type="button"
                onClick={() => remove(i)}
                title="Remove"
                className="no-drag cl-focus shrink-0 text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-destructive)]"
              >
                <Trash size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

/**
 * Modes pane (two-column, Cluely-style): left = the mode list with the live “Active” marker; right = the
 * selected mode's editable system prompt + per-mode context files + a “Set active” control. Selecting a
 * mode on the left only changes what you're VIEWING/EDITING; “Set active” is the sticky footer action.
 */
export function PersonalizeModes({
  settings,
  patch
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
}): JSX.Element {
  const active = settings.mode
  const customModes: CustomMode[] = settings.customModes ?? []
  const [selected, setSelected] = useState<string>(active)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [creatingNew, setCreatingNew] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [modeErr, setModeErr] = useState<string | null>(null)
  const locked = settings.managedKeys.includes('mode')
  // Gates custom-mode create/rename/delete — distinct from `locked` above (which only gates "Set active").
  // Without this, the trigger buttons silently no-op (patch() drops locked keys) and deleteCustomMode's
  // combined patch can partially apply (customModes entry dropped while modePrompts/contextDocs land).
  const customModesLocked = settings.managedKeys.includes('customModes')
  const overflowRef = useRef<HTMLDivElement>(null)
  // Two-step inline confirm for the overflow menu's destructive actions (mirrors the CLI-install
  // "confirming" phase idiom elsewhere in this file) — first click asks, second click actually deletes.
  const [confirmClear, setConfirmClear] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Dismiss the "Mode options" overflow menu on an outside click or Escape (mirrors Bar.tsx's
  // ModePicker outside-click pattern).
  useEffect(() => {
    if (!overflowOpen) return
    const onDown = (e: MouseEvent): void => {
      if (overflowRef.current?.contains(e.target as Node)) return
      setOverflowOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // Stop this Escape from reaching any window-level handler while just closing this menu.
      e.stopPropagation()
      setOverflowOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [overflowOpen])

  // Ensure selected still exists (could be deleted)
  const allIds = [
    ...MODE_GROUPS.flatMap((g) => g.modes as string[]),
    ...customModes.map((c) => c.id)
  ]
  const safeSelected = allIds.includes(selected) ? selected : (MODE_GROUPS[0]?.modes[0] ?? 'general')
  const selectedLabel = modeLabel(safeSelected, customModes)
  const isBuiltinSelected = safeSelected in BUILTIN_MODE_LABELS

  // Drop any pending "are you sure?" state when the menu closes or the viewed mode changes, so a stale
  // confirm from a different mode can never be armed by a later click.
  useEffect(() => {
    setConfirmClear(false)
    setConfirmDelete(false)
  }, [overflowOpen, safeSelected])

  const createNewMode = (): void => {
    if (customModesLocked) { setCreatingNew(false); setNewLabel(''); return }
    const label = newLabel.trim()
    // Fires on both Enter and the input's onBlur (clicking away) — an empty/whitespace-only label must
    // cancel instead of silently persisting a junk "New Mode" entry.
    if (!label) {
      setCreatingNew(false)
      setNewLabel('')
      return
    }
    // Schema cap (ipc.ts customModes .max(40)) — past this, setSettings drops the whole customModes key
    // and the mode picker silently falls back to General. Stop before that and say why, instead of
    // letting the create appear to work and then silently reverting.
    if (customModes.length >= 40) {
      setModeErr('40-mode limit reached.')
      setCreatingNew(false)
      setNewLabel('')
      return
    }
    const id = `custom-${Date.now()}`
    patch({ customModes: [...customModes, { id, label }] })
    setSelected(id)
    setCreatingNew(false)
    setNewLabel('')
    setModeErr(null)
  }

  const startRename = (): void => {
    setRenameValue(selectedLabel)
    setRenaming(true)
    setOverflowOpen(false)
  }

  const commitRename = (): void => {
    if (customModesLocked) { setRenaming(false); return }
    const label = renameValue.trim()
    if (label && !isBuiltinSelected) {
      patch({ customModes: customModes.map((c) => c.id === safeSelected ? { ...c, label } : c) })
    }
    setRenaming(false)
  }

  const deleteCustomMode = (): void => {
    if (customModesLocked) { setOverflowOpen(false); setConfirmDelete(false); return }
    setOverflowOpen(false)
    const nextModes = customModes.filter((c) => c.id !== safeSelected)
    const nextPrompts = { ...settings.modePrompts }
    delete nextPrompts[safeSelected]
    const nextDocs = { ...settings.contextDocs }
    delete nextDocs[safeSelected]
    const next: Partial<PublicSettings> = {
      customModes: nextModes,
      modePrompts: nextPrompts,
      contextDocs: nextDocs
    }
    if (active === safeSelected) next.mode = 'general'
    patch(next)
    setSelected('general')
  }

  const resetBuiltinPrompt = (): void => {
    setOverflowOpen(false)
    const m = { ...settings.modePrompts }
    delete m[safeSelected]
    patch({ modePrompts: m })
  }

  const clearBuiltinDocs = (): void => {
    setOverflowOpen(false)
    const d = { ...settings.contextDocs }
    delete d[safeSelected]
    patch({ contextDocs: d })
  }

  const renderModeButton = (m: string, label: string): JSX.Element => {
    const isSel = m === safeSelected
    const isActive = m === active
    return (
      <button
        key={m}
        type="button"
        onClick={() => { setSelected(m); setOverflowOpen(false) }}
        aria-pressed={isSel}
        className={[
          'no-drag cl-focus flex items-center gap-2 rounded-[10px] border px-2.5 py-1.5 text-left transition-colors',
          isSel
            ? 'border-[var(--cl-primary)]/40 bg-[var(--cl-primary-soft)]'
            : 'border-transparent hover:bg-white/[0.04]'
        ].join(' ')}
      >
        <span
          className={[
            'grid size-5 shrink-0 place-items-center rounded-[6px] text-[10px] font-semibold',
            isActive ? 'bg-[var(--cl-primary)] text-white' : 'bg-white/[0.06] text-[color:var(--cl-muted-foreground)]'
          ].join(' ')}
        >
          {label[0]?.toUpperCase() ?? '?'}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-[color:var(--cl-foreground)]">
          {label}
        </span>
        {isActive && <CircleCheck size={13} className="shrink-0 text-[color:var(--cl-primary)]" />}
      </button>
    )
  }

  return (
    <div className="grid grid-cols-[176px_1fr] gap-4">
      {/* Left — mode list grouped by MODE_GROUPS + Custom. No inner scroll cap: the panel already has
          room for every built-in mode, and the tab's own outer scroll (<main> above) handles overflow
          on the rare account with enough custom modes to actually need it. */}
      <div className="flex flex-col gap-0.5">
        {/* + New Mode button */}
        {creatingNew ? (
          <div className="mb-1 flex items-center gap-1">
            <input
              autoFocus
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') createNewMode()
                // stopPropagation: App.tsx's global Escape handler blur()s the focused input, which
                // would fire onBlur={createNewMode} and create the mode the user is cancelling.
                if (e.key === 'Escape') { e.stopPropagation(); setCreatingNew(false); setNewLabel('') }
              }}
              onBlur={createNewMode}
              placeholder="Mode name…"
              className={`flex-1 min-w-0 text-[12px] ${ctl} py-1.5`}
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => { setCreatingNew(true); setModeErr(null) }}
            disabled={customModesLocked}
            className="no-drag cl-focus mb-1.5 flex items-center gap-1.5 rounded-[10px] border border-dashed border-[var(--cl-border)] px-2.5 py-1.5 text-[11px] text-[color:var(--cl-muted-foreground)] hover:border-[var(--cl-primary)]/50 hover:text-[color:var(--color-accent-text)] transition-colors disabled:opacity-50 disabled:hover:border-[var(--cl-border)] disabled:hover:text-[color:var(--cl-muted-foreground)]"
          >
            <Plus size={12} /> New Mode
          </button>
        )}

        {modeErr && (
          <div className="mb-1.5 px-1 text-[11px] text-[color:var(--color-danger)]">{modeErr}</div>
        )}

        {/* Built-in groups */}
        {MODE_GROUPS.map((group) => (
          <div key={group.label} className="flex flex-col gap-0.5">
            <div className="cl-eyebrow mb-0.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--cl-muted-foreground)]">
              {group.label}
            </div>
            {group.modes.map((m) => renderModeButton(m, BUILTIN_MODE_LABELS[m]))}
          </div>
        ))}

        {/* Custom modes group */}
        {customModes.length > 0 && (
          <div className="mt-1 flex flex-col gap-0.5">
            <div className="cl-eyebrow mb-0.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--cl-muted-foreground)]">
              Custom
            </div>
            {customModes.map((c) => renderModeButton(c.id, c.label))}
          </div>
        )}
      </div>

      {/* Right — selected mode's prompt + files + sticky footer */}
      <div className="flex min-w-0 flex-col gap-4">
        {/* Header */}
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            {renaming && !isBuiltinSelected ? (
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename()
                  // stopPropagation: App.tsx's global Escape handler blur()s the focused input, which
                  // would fire onBlur={commitRename} and save the rename the user is cancelling.
                  if (e.key === 'Escape') { e.stopPropagation(); setRenaming(false) }
                }}
                onBlur={commitRename}
                className={`text-[18px] font-semibold bg-transparent border-b border-[var(--cl-primary)] outline-none text-[color:var(--cl-foreground)] w-full max-w-[200px]`}
              />
            ) : (
              <div className="truncate text-[18px] font-semibold text-[color:var(--cl-foreground)]">
                {selectedLabel}
              </div>
            )}
            <div className="text-[12px] text-[color:var(--cl-muted-foreground)]">
              {active === safeSelected ? 'This is your active mode.' : 'Previewing. Set active below.'}
            </div>
          </div>

          {/* Overflow menu */}
          <div ref={overflowRef} className="relative flex items-center gap-2">
            {active === safeSelected && (
              <span className="flex shrink-0 items-center gap-1 rounded-full bg-[var(--cl-primary-soft)] px-2.5 py-1 text-[11px] font-medium text-[color:var(--cl-primary)]">
                <CircleCheck size={12} /> Active
              </span>
            )}
            <button
              type="button"
              onClick={() => setOverflowOpen((o) => !o)}
              aria-label="Mode options"
              aria-haspopup="menu"
              aria-expanded={overflowOpen}
              className="no-drag cl-focus flex size-7 items-center justify-center rounded-md text-[color:var(--cl-muted-foreground)] hover:bg-white/[0.06] hover:text-[color:var(--cl-foreground)]"
            >
              <MoreHorizontal size={15} />
            </button>
            {overflowOpen && (
              <div className="absolute right-0 top-8 z-20 min-w-[180px] rounded-[10px] border border-[var(--cl-border)] bg-[var(--cl-bg)] shadow-lg">
                {isBuiltinSelected ? (
                  <>
                    <button
                      type="button"
                      onClick={resetBuiltinPrompt}
                      disabled={settings.managedKeys.includes('modePrompts')}
                      className="no-drag w-full px-3 py-2 text-left text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.05] rounded-t-[10px] disabled:opacity-50 disabled:hover:bg-transparent"
                    >
                      <RotateCcw size={12} className="mr-2 inline" />
                      Reset prompt to default
                    </button>
                    {confirmClear ? (
                      <div className="flex items-center gap-1 px-3 py-2 rounded-b-[10px]">
                        <button
                          type="button"
                          onClick={clearBuiltinDocs}
                          className="no-drag flex-1 text-left text-[12px] font-medium text-[color:var(--cl-destructive)] hover:underline"
                        >
                          Confirm clear?
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmClear(false)}
                          className="no-drag text-[12px] text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-foreground)]"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmClear(true)}
                        disabled={settings.managedKeys.includes('contextDocs')}
                        className="no-drag w-full px-3 py-2 text-left text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.05] rounded-b-[10px] disabled:opacity-50 disabled:hover:bg-transparent"
                      >
                        <Trash size={12} className="mr-2 inline" />
                        Clear context files
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={startRename}
                      disabled={customModesLocked}
                      className="no-drag w-full px-3 py-2 text-left text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.05] rounded-t-[10px] disabled:opacity-50 disabled:hover:bg-transparent"
                    >
                      Rename
                    </button>
                    {confirmDelete ? (
                      <div className="flex items-center gap-1 px-3 py-2 rounded-b-[10px]">
                        <button
                          type="button"
                          onClick={deleteCustomMode}
                          className="no-drag flex-1 text-left text-[12px] font-medium text-[color:var(--cl-destructive)] hover:underline"
                        >
                          Confirm delete?
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(false)}
                          className="no-drag text-[12px] text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-foreground)]"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(true)}
                        disabled={customModesLocked}
                        className="no-drag w-full px-3 py-2 text-left text-[12px] text-[color:var(--cl-destructive)] hover:bg-white/[0.05] rounded-b-[10px] disabled:opacity-50 disabled:hover:bg-transparent"
                      >
                        <Trash size={12} className="mr-2 inline" />
                        Delete mode
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Prompt editor + context docs */}
        <ModePromptEditor settings={settings} patch={patch} mode={safeSelected} modeDisplayLabel={selectedLabel} />
        <ContextDocs settings={settings} patch={patch} mode={safeSelected} modeDisplayLabel={selectedLabel} />

        {/* Sticky footer: Set active */}
        {active !== safeSelected && (
          <div className="flex items-center justify-end gap-2 border-t border-[var(--cl-border)] pt-3">
            {locked && <ManagedChip keys={settings.managedKeys} k="mode" />}
            <button
              type="button"
              disabled={locked}
              onClick={() => patch({ mode: safeSelected })}
              className="no-drag cl-focus rounded-[10px] bg-[var(--cl-primary)] px-4 py-2 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              Set active
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
