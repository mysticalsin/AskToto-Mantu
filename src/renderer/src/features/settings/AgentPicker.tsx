import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, ChevronDown, Search } from 'lucide-react'
import type { DustAgent } from '@shared/ipc'
import { AgentStatus } from '../../components/AgentStatus'
import { ctl } from '../../ui/ctl'

/**
 * Scrollable, searchable popup for picking a Dust agent — replaces a native <select> so a long agent
 * list (with descriptions) is actually browsable instead of squeezed into the OS's own dropdown chrome.
 * Falls back to a bare text input whenever `agents` hasn't loaded yet (or failed), so an sId can still
 * be pasted by hand — same escape hatch the old <select>/<input> pair offered. Shared by DustSetup's
 * base- and thinking-agent controls below: `emptyOption` adds a top "clear" row for the thinking
 * picker's "same as base" state, `defaultId` tags one row " (default)" for the base picker's Métis
 * agent. Dismiss-on-outside-click/Escape mirrors the "Mode options" overflow menu elsewhere in this file.
 */
export function AgentPicker({
  id,
  label,
  value,
  agents,
  loading,
  err,
  onSelect,
  placeholder,
  disabled,
  emptyOption,
  defaultId,
  onEmptyBlur
}: {
  id?: string
  label: string
  value: string
  agents: DustAgent[] | null
  loading: boolean
  err: string | null
  onSelect: (sId: string) => void
  placeholder: string
  disabled?: boolean
  /** Label for an extra sId:'' row at the top of the list (e.g. "Same as base agent"). Omit to require
   *  a real selection (the base-agent picker never offers an empty option). */
  emptyOption?: string
  /** sId to annotate with " (default)" in its row + trigger label (e.g. the Métis base agent). */
  defaultId?: string
  /** Fired when the pre-load fallback text input is blurred while empty (only reachable path to a blank
   *  value, since the popup itself never offers one unless `emptyOption` is set) — lets a caller like the
   *  base-agent picker restore its default instead of persisting a blank sId. */
  onEmptyBlur?: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // Stop this Escape from reaching any window-level handler while just closing this popup.
      e.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // Reset the filter and focus it fresh on every open, so re-opening never shows a stale search.
  useEffect(() => {
    if (!open) return
    setQuery('')
    const f = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(f)
  }, [open])

  // No agents loaded yet: loading spinner, or (failed/empty) the same bare-sId input the old code
  // fell back to, plus the error so the user knows why they're typing an id instead of picking one.
  if (!agents || agents.length === 0) {
    if (loading) {
      return (
        <div className={['flex w-full items-center gap-2 opacity-70', ctl].join(' ')}>
          <AgentStatus kind="searching" size="inline" caption />
        </div>
      )
    }
    return (
      <div className="flex flex-col gap-1">
        <input
          id={id}
          value={value}
          onChange={(e) => onSelect(e.target.value)}
          onBlur={(e) => {
            if (!e.target.value.trim()) onEmptyBlur?.()
          }}
          placeholder={placeholder}
          aria-label={label}
          disabled={disabled}
          className={['w-full', ctl, disabled ? 'opacity-60' : ''].join(' ')}
        />
        {err && (
          <div className="flex items-center gap-1.5 text-[11px] text-[color:var(--cl-destructive)]">
            <AlertCircle size={12} /> {err}
          </div>
        )}
      </div>
    )
  }

  // A previously-saved sId that no longer exists in this workspace must stay visible + selectable
  // (not silently vanish into a blank trigger) — same stale-id guard the old <select> had.
  const stale = !!value && !agents.some((a) => a.sId === value)
  const rows: { sId: string; name: string; description: string }[] = [
    ...(emptyOption !== undefined ? [{ sId: '', name: emptyOption, description: '' }] : []),
    ...(stale ? [{ sId: value, name: value, description: 'Not in your workspace' }] : []),
    ...agents.map((a) => ({
      sId: a.sId,
      name: a.name + (defaultId && a.sId === defaultId ? ' (default)' : ''),
      description: a.description || ''
    }))
  ]
  const q = query.trim().toLowerCase()
  const filtered = q
    ? rows.filter((r) => r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q))
    : rows
  const selectedRow = rows.find((r) => r.sId === value)
  const triggerLabel = selectedRow ? selectedRow.name : value || placeholder

  return (
    <div ref={rootRef} className="relative">
      <button
        id={id}
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        className={[
          'flex w-full items-center justify-between gap-2 text-left',
          ctl,
          disabled ? 'opacity-60' : 'hover:bg-white/[0.06]'
        ].join(' ')}
      >
        <span className={['truncate', selectedRow || value ? '' : 'text-[color:var(--cl-muted-foreground)]'].join(' ')}>
          {triggerLabel}
        </span>
        <ChevronDown
          size={14}
          className={[
            'shrink-0 text-[color:var(--cl-muted-foreground)] transition-transform',
            open ? 'rotate-180' : ''
          ].join(' ')}
        />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 flex flex-col overflow-hidden rounded-[10px] border border-[var(--cl-border)] bg-[var(--cl-bg,#1a1a2e)] shadow-lg">
          <div className="relative border-b border-[var(--cl-border)] p-1.5">
            <Search
              size={12}
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[color:var(--cl-muted-foreground)]"
            />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  // Stop this Escape from reaching any window-level handler while just closing the popup.
                  e.stopPropagation()
                  setOpen(false)
                }
                if (e.key === 'Enter' && filtered[0]) {
                  onSelect(filtered[0].sId)
                  setOpen(false)
                }
              }}
              placeholder="Filter agents…"
              className={'w-full pl-7 text-[12px] ' + ctl}
            />
          </div>
          <div className="scroll-thin flex max-h-[280px] flex-col gap-0.5 overflow-y-auto p-1">
            {filtered.length === 0 && (
              <div className="px-2 py-3 text-center text-[11px] text-[color:var(--cl-muted-foreground)]">
                No matching agents.
              </div>
            )}
            {filtered.map((r) => {
              const isSel = r.sId === value
              return (
                <button
                  key={r.sId || '__empty__'}
                  type="button"
                  onClick={() => {
                    onSelect(r.sId)
                    setOpen(false)
                  }}
                  className={[
                    'no-drag cl-focus flex items-center gap-2 rounded-[8px] border px-2.5 py-1.5 text-left transition-colors',
                    isSel
                      ? 'border-[var(--cl-primary)]/40 bg-[var(--cl-primary-soft)]'
                      : 'border-transparent hover:bg-white/[0.06]'
                  ].join(' ')}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] font-medium text-[color:var(--cl-foreground)]">{r.name}</div>
                    {r.description && (
                      <div className="truncate text-[11px] text-[color:var(--cl-muted-foreground)]">
                        {r.description}
                      </div>
                    )}
                  </div>
                  {isSel && <Check size={13} className="shrink-0 text-[color:var(--cl-primary)]" />}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
