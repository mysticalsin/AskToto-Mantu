/**
 * SensitiveDataSection.tsx — Settings › Privacy › Sensitive data (moved verbatim out of SettingsRoot.tsx).
 */
import { Lock } from 'lucide-react'
import type { PublicSettings } from '@shared/ipc'
import { Section } from '../../ui/Section'
import { ToggleRow } from '../../ui/Toggle'

export function SensitiveDataSection({
  settings,
  patch
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => Promise<PublicSettings> | void
}): JSX.Element {
  return (
    <Section title="Sensitive data" desc="Keep secrets out of what's sent to AI providers." icon={Lock}>
      <ToggleRow
        label="Redact secrets before sending to AI"
        desc="Strips credit-card numbers, API keys, SSNs, and private keys from the captured transcript before it goes to a cloud model. Your typed questions and the saved transcript are never changed."
        on={settings.redactSensitive}
        onChange={(v) => patch({ redactSensitive: v })}
        disabled={settings.managedKeys.includes('redactSensitive')}
      >
        <div className="mt-1.5 text-[11px] leading-snug text-[color:var(--color-danger)]">
          This only scrubs text. Screenshots sent for screen-based questions are NOT redacted; anything visible
          on-screen (passwords, IDs, open documents) goes to the provider as-is. Turn on Private View before capturing a
          screen you don't want sent.
        </div>
      </ToggleRow>
    </Section>
  )
}
