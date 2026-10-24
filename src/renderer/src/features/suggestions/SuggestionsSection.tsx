/**
 * Suggestions in Settings (G69, CAP-32): the on/off switch, Check now, queue health and the carousel. Opening Settings
 * is a direct request, so nothing here is quiet-gated.
 */
import { useState } from 'react'
import type { PublicSettings } from '@shared/ipc'
import { ToggleRow } from '../../ui/Toggle'
import { SuggestionCarousel, useSuggestionList } from './SuggestionCarousel'
import { ackRefusalCopy, queueHealth } from './suggestion-copy'

export function SuggestionsSection({
  settings,
  patch
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
}): JSX.Element {
  const source = useSuggestionList()
  const [checking, setChecking] = useState(false)
  const [notice, setNotice] = useState('')
  const managed = (settings.managedKeys ?? []).includes('suggestionsEnabled')
  const enabled = settings.suggestionsEnabled === true
  const health = source.list ? queueHealth(source.list) : null

  const checkNow = (): void => {
    setChecking(true)
    setNotice('')
    void window.toto.suggestions
      .checkNow()
      .then((result) => {
        if (!result.ok) setNotice(ackRefusalCopy(result.reason))
      })
      .finally(() => {
        setChecking(false)
        void source.refetch()
      })
  }

  return (
    <div className="flex flex-col gap-2">
      <ToggleRow
        label="Suggestions"
        desc="Off by default. When on, Métis reads your calendar and memory to suggest what to prepare."
        on={enabled}
        disabled={managed}
        onChange={(v) => {
          patch({ suggestionsEnabled: v })
          setTimeout(() => void source.refetch(), 300)
        }}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="no-drag cl-focus min-h-[28px] rounded-md px-2.5 text-[12px] text-[color:var(--cl-primary)] hover:bg-white/10 disabled:opacity-40"
          disabled={!enabled || checking}
          onClick={checkNow}
        >
          Check now
        </button>
        <span role="status" aria-live="polite" className="text-[12px] text-[color:var(--cl-muted-foreground)]">
          {notice || health?.text || ''}
        </span>
      </div>
      {enabled && <SuggestionCarousel mode="settings" source={source} />}
    </div>
  )
}
