import { Eye } from 'lucide-react'
import { Section } from '../../ui/Section'
import { AmbientObservationSection } from './AmbientObservationSection'
import { DataDisclosureSection } from './DataDisclosureSection'
import { TaskBrowserSection } from './TaskBrowserSection'

/**
 * Settings › Privacy: the per-data-type table (G83), what Métis notices in the background (G47) and the task
 * browser's separate profile (G41). The table mounts here so SettingsRoot stays unchanged.
 */
export function PrivacyObservationSections(): JSX.Element {
  return (
    <>
      <DataDisclosureSection />
      <Section
        title="Background observation"
        desc="What Métis notices in the background, and what it keeps."
        icon={Eye}
      >
        <AmbientObservationSection />
      </Section>
      <TaskBrowserSection />
    </>
  )
}
