import { useId } from 'react'
import type { PublicSettings } from '@shared/ipc'
import { ctl } from '../../ui/ctl'
import { ManagedChip } from '../../ui/ManagedChip'

/** The live translation target (G73): a translation under each final line; the original line is never changed. */
export function LiveTranslationRow({
  settings,
  patch
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
}): JSX.Element {
  const managed = settings.managedKeys.includes('liveTranslationTarget')
  // The select is named by the title alone and described by the help line, not by the whole label's text.
  const titleId = useId()
  const helpId = useId()
  return (
    <label className="flex flex-col gap-1 px-1 py-2 text-[12px] text-[color:var(--cl-muted-foreground)]">
      <span className="flex items-center gap-2 text-[13px] text-[color:var(--cl-foreground)]">
        <span id={titleId}>Live translation</span> <ManagedChip keys={settings.managedKeys} k="liveTranslationTarget" />
      </span>
      <span id={helpId}>Show a translation under each line. The original line is never changed.</span>
      <select
        aria-labelledby={titleId}
        aria-describedby={helpId}
        value={settings.liveTranslationTarget}
        onChange={(e) => patch({ liveTranslationTarget: e.target.value as PublicSettings['liveTranslationTarget'] })}
        disabled={managed}
        className={'w-full ' + ctl}
      >
        <option value="off">Off</option>
        <option value="en">English</option>
        <option value="fr">French</option>
        <option value="pt-BR">Portuguese (Brazil)</option>
        <option value="es">Spanish</option>
      </select>
    </label>
  )
}
