import { MessageSquareQuote } from 'lucide-react'
import type { PublicSettings } from '@shared/ipc'
import { INTERRUPTION_MODES, type InterruptionMode } from '@shared/proactive-settings'
import { Section } from '../../ui/Section'
import { ManagedChip } from '../../ui/ManagedChip'
import { ctl } from '../../ui/ctl'

/** What the person is told: behavior per mode, not intensity. Kept in one place so it is reviewed together. */
export const PROACTIVE_CONTROLS_COPY = {
  title: 'When Métis speaks up',
  desc: 'Choose when Métis may show an answer card without being asked. Asking with the button, the shortcut or your voice always works.',
  label: 'Automatic cards',
  modes: {
    manual: {
      label: 'Only when I ask',
      desc: 'No automatic cards. Métis answers only when you ask.'
    },
    questions: {
      label: 'When someone asks a question',
      desc: 'Answers questions automatically, up to 6 per 10 minutes, and skips repeats.'
    }
  } satisfies Record<InterruptionMode, { label: string; desc: string }>
} as const

export function ProactiveControlsSection({
  settings,
  patch
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
}) {
  const locked = settings.managedKeys.includes('interruptionMode')
  return (
    <Section title={PROACTIVE_CONTROLS_COPY.title} desc={PROACTIVE_CONTROLS_COPY.desc} icon={MessageSquareQuote}>
      <label className="flex flex-col gap-1 px-1 py-2 text-[12px] text-[color:var(--cl-muted-foreground)]">
        <span className="flex items-center gap-2 text-[13px] text-[color:var(--cl-foreground)]">
          {PROACTIVE_CONTROLS_COPY.label} <ManagedChip keys={settings.managedKeys} k="interruptionMode" />
        </span>
        <span>{PROACTIVE_CONTROLS_COPY.modes[settings.interruptionMode].desc}</span>
        <select
          value={settings.interruptionMode}
          onChange={(e) => patch({ interruptionMode: e.target.value as InterruptionMode })}
          disabled={locked}
          className={'w-full ' + ctl}
        >
          {INTERRUPTION_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {PROACTIVE_CONTROLS_COPY.modes[mode].label}
            </option>
          ))}
        </select>
      </label>
    </Section>
  )
}
