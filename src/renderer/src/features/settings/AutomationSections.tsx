/** Routines and suggestions in the Intelligence tab (G69). */
import type { PublicSettings } from '@shared/ipc'
import { Section } from '../../ui/Section'
import { RoutinesSection } from '../routines/RoutinesSection'
import { SuggestionsSection } from '../suggestions/SuggestionsSection'

export function AutomationSections({
  settings,
  patch
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
}): JSX.Element {
  return (
    <>
      <Section title="Routines" desc="Runs while Métis is open, on this Mac.">
        <RoutinesSection />
      </Section>
      <Section title="Suggestions" desc="Read-only checks of your calendar and memory. Nothing is sent or changed.">
        <SuggestionsSection settings={settings} patch={patch} />
      </Section>
    </>
  )
}
