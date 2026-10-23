import { Eye } from 'lucide-react'
import { Section } from '../../ui/Section'
import { AmbientObservationSection } from './AmbientObservationSection'
import { TaskBrowserSection } from './TaskBrowserSection'

/** Settings › Privacy: what Métis notices in the background (G47) and the task browser's separate profile (G41). */
export function PrivacyObservationSections(): JSX.Element {
  return (
    <>
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
