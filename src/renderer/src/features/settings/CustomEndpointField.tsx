/**
 * CustomEndpointField.tsx — the Custom provider's endpoint, validated inline (Apple HIG, Settings: invalid input is
 * explained next to the field, never by an alert, and the last valid value stays in use).
 *
 * Typing never shows an error; leaving the field (or pressing Return) checks it. A valid address saves at once,
 * with no Save button, and a refused or failed save is reported in the same place.
 */
import { useEffect, useId, useState } from 'react'
import { customEndpointError } from '@shared/custom-endpoint'
import type { PublicSettings } from '@shared/ipc'
import { patchSettingsChecked } from '../../lib/settings-patch-result'
import { ctl } from '../../ui/ctl'

export function CustomEndpointField({
  value,
  required,
  disabled,
  patch
}: {
  value: string
  required: boolean
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
    const invalid = customEndpointError(next, { required })
    if (invalid) {
      setError(invalid)
      return
    }
    setError(null)
    if (next === value) return
    const result = await patchSettingsChecked(patch, { customBaseUrl: next })
    if (!result.ok) setError(result.message)
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <label htmlFor={inputId} className="sr-only">
        Custom endpoint URL
      </label>
      <input
        id={inputId}
        type="url"
        value={draft}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        placeholder="https://your-endpoint/v1"
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
        className={['min-w-0 flex-1', ctl, disabled ? 'opacity-60' : ''].join(' ')}
      />
      {error && (
        <p id={errorId} role="alert" className="m-0 text-[11px] leading-snug text-[color:var(--cl-destructive)]">
          {error}
        </p>
      )}
    </div>
  )
}
