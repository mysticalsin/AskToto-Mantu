/**
 * OperatorUrlField.tsx — the Operator URL, validated when you leave the field (Apple HIG, Settings: invalid input is
 * explained next to the field, never by an alert, and the last valid value stays in use).
 *
 * The settings schema accepts only an empty value or an https:// address, so saving on every keystroke dropped
 * every partial value and the field could not be typed into. Typing never shows an error and never writes; leaving
 * the field (or pressing Return) checks it, and a valid address saves at once.
 */
import { useEffect, useId, useState } from 'react'
import { DEFAULT_OPERATOR_URL } from '@shared/operator'
import type { PublicSettings } from '@shared/ipc'
import { patchSettingsChecked } from '../../lib/settings-patch-result'
import { ctl } from '../../ui/ctl'

export const OPERATOR_URL_INVALID = 'Enter an https:// address, or leave it empty.'

/** Why `url` cannot be saved as the Operator URL, or null when it can. Empty means "use the default". */
export function operatorUrlError(url: string): string | null {
  const value = url.trim()
  if (value === '') return null
  if (!/^https:\/\//i.test(value)) return OPERATOR_URL_INVALID
  try {
    return new URL(value).hostname ? null : OPERATOR_URL_INVALID
  } catch {
    return OPERATOR_URL_INVALID
  }
}

export function OperatorUrlField({
  value,
  disabled,
  patch
}: {
  value: string
  disabled: boolean
  patch: (p: Partial<PublicSettings>) => Promise<PublicSettings> | void
}): JSX.Element {
  const inputId = useId()
  const errorId = useId()
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState<string | null>(null)
  // A value changed elsewhere (another window, managed policy) replaces the draft.
  useEffect(() => setDraft(value), [value])

  const commit = async (): Promise<void> => {
    const next = draft.trim()
    const invalid = operatorUrlError(next)
    if (invalid) {
      setError(invalid)
      return
    }
    setError(null)
    if (next === value) return
    const result = await patchSettingsChecked(patch, { operatorUrl: next })
    if (!result.ok) setError(result.message)
  }

  return (
    <div className="flex flex-col gap-1 px-1 py-2">
      <label htmlFor={inputId} className="text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
        Operator URL
      </label>
      <input
        id={inputId}
        value={draft}
        spellCheck={false}
        autoComplete="off"
        placeholder={DEFAULT_OPERATOR_URL}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(e) => {
          setDraft(e.target.value)
          if (error) setError(null)
        }}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit()
        }}
        className={`${ctl} w-full`}
      />
      {error && (
        <p id={errorId} role="alert" className="m-0 text-[11px] leading-snug text-[color:var(--cl-destructive)]">
          {error}
        </p>
      )}
      <span className="text-[11px] text-[color:var(--cl-muted-foreground)]">
        Leave empty to use {DEFAULT_OPERATOR_URL}. Changing this address disconnects your licence; activate it again for
        the new service. Only change it when instructed by your administrator.
      </span>
    </div>
  )
}
