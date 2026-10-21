import { CircleCheck, Sparkles } from 'lucide-react'
import appPackage from '../../../../../package.json'
import { MantuLogo } from '../../components/MantuLogo'
import { MetisMark } from '../../components/MetisMark'
import { Section } from '../../ui/Section'
import { DiagnosticsSection } from './DiagnosticsSection'
import { UpdatesSection } from './SupportBundleSection'

declare const __METIS_FEEDBACK_EMAIL__: string

export const METIS_FEEDBACK_EMAIL = typeof __METIS_FEEDBACK_EMAIL__ === 'string' ? __METIS_FEEDBACK_EMAIL__.trim() : ''

/** Settings → About: the update check, diagnostics, the story, the thanks and the version footer. */
export function AboutTab(): JSX.Element {
  return (
    // Everything in About is centered: the story, the thanks, and the footer.
    <div className="flex flex-col gap-6 text-center">
      {/* Microsoft sign-in is in Calendar, the license is in Profile, and permissions + usage
                    moved to Privacy. About is the story — plus the update check, which lives here so
                    every build (including ones that can't auto-install) can still discover a release. */}
      <UpdatesSection />
      <DiagnosticsSection />
      <Section title="Why “Métis”" desc="The name is the mission." icon={Sparkles}>
        <div className="flex flex-col items-center gap-2 pb-1 text-center">
          <MetisMark size={76} />
          <p className="text-[12px] leading-relaxed text-[color:var(--cl-muted-foreground)]">
            Métis is the Greek goddess of cunning, wisdom, and prudence, Zeus&apos;s first counselor and the mother of
            Athena. She&apos;s a fascinating figure because she stands for a very particular kind of intelligence: not
            just &ldquo;being intelligent,&rdquo; but knowing how to see what&apos;s coming, adapt, maneuver, and choose
            exactly the right moment. That&apos;s the job of this app. It listens with you, reads the room, and puts the
            right words within reach at the moment you need them.
          </p>
        </div>
      </Section>
      <Section title="Thanks" desc="Métis got better because people believed in it early." icon={CircleCheck}>
        <p className="text-[12px] leading-relaxed text-[color:var(--cl-muted-foreground)]">
          To{' '}
          <a
            href="https://www.linkedin.com/in/marc-bisiou-1a79ba78/"
            target="_blank"
            rel="noopener noreferrer"
            className="no-drag font-medium text-[color:var(--cl-primary)] transition-colors hover:underline"
          >
            Marc Bisiou
          </a>
          , patient zero: the first to test every build, and generous with the feedback and support that shaped this
          app.
        </p>
        <p className="mt-2.5 text-[12px] leading-relaxed text-[color:var(--cl-muted-foreground)]">
          And to{' '}
          <a
            href="https://www.linkedin.com/in/berichard/"
            target="_blank"
            rel="noopener noreferrer"
            className="no-drag font-medium text-[color:var(--cl-primary)] transition-colors hover:underline"
          >
            Benjamin Richard
          </a>{' '}
          and{' '}
          <a
            href="https://www.linkedin.com/in/yanezsondagur/"
            target="_blank"
            rel="noopener noreferrer"
            className="no-drag font-medium text-[color:var(--cl-primary)] transition-colors hover:underline"
          >
            Yanez Sondagur
          </a>
          , for the support and belief that made this possible.
        </p>
      </Section>
      {/* Model/library license attributions live in THIRD_PARTY_NOTICES.md, shipped in the
                    app's install directory (electron-builder extraFiles) — kept out of the UI on
                    purpose (the owner, 2026-07-05). */}
      <div className="flex flex-col items-center gap-2.5 pb-2 pt-4">
        <MantuLogo size={190} />
        <div className="text-[13px] font-semibold text-[color:var(--cl-foreground)]">
          Métis {appPackage.version} · Mantu
        </div>
        <div className="flex items-center gap-2 text-[11px] text-[color:var(--cl-muted-foreground)]">
          <a
            href="https://www.mantu.com/legal/privacy-policy"
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-[color:var(--cl-foreground)]"
          >
            Privacy
          </a>
          <span aria-hidden>·</span>
          <a
            href="https://www.mantu.com/legal/data-handling"
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-[color:var(--cl-foreground)]"
          >
            Data handling
          </a>
          {METIS_FEEDBACK_EMAIL ? (
            <>
              <span aria-hidden>·</span>
              <a
                href={`mailto:${METIS_FEEDBACK_EMAIL}`}
                className="transition-colors hover:text-[color:var(--cl-foreground)]"
              >
                Support
              </a>
              <span aria-hidden>·</span>
              <a
                href={`mailto:${METIS_FEEDBACK_EMAIL}?subject=M%C3%A9tis%20feedback`}
                className="transition-colors hover:text-[color:var(--cl-foreground)]"
              >
                Send feedback
              </a>
            </>
          ) : null}
        </div>
        <div className="text-[11px] text-[color:var(--cl-muted-foreground)]">Built at Mantu</div>
      </div>
    </div>
  )
}
