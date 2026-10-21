import { Markdown } from '../Markdown'
import { ModeRecapView, modeRecapSections } from '../ModeRecap'

export const INCOMPLETE_RECAP_COPY = 'This summary may be incomplete. Review it before using it, or retry.'

/** An in-place recap edit that was saved, paired with the recap text it replaced. */
export type EditedRecap = { base: string; text: string }

/** The recap markdown every consumer reads (Markdown render, Copy Summary, Export JSON/PDF, CRM payload),
 *  so an edit reflects everywhere at once. The in-place copy of a saved edit stands only while App is
 *  still handing back the text that edit was made against: Regenerate re-runs the recap and OVERWRITES
 *  this meeting on disk, and a copy that outlived that write kept the old edited text on screen — and in
 *  every export and the CRM payload — while the file said something else, with no recovery short of
 *  leaving the screen and reopening. Comparing against `base` makes the override yield to the streaming
 *  regeneration and then to the regenerated recap the moment either arrives. */
export function displayedRecapText(edited: EditedRecap | null, incoming: string | undefined): string {
  const text = incoming ?? ''
  return edited && edited.base === text ? edited.text : text
}

export function RecapBody({ text, mode }: { text: string; mode: string }): JSX.Element {
  const sections = modeRecapSections(text, mode)
  if (sections.length >= 2) return <ModeRecapView mode={mode} sections={sections} />
  return <Markdown>{text}</Markdown>
}

/** The line under a save-failure banner. It used to be an unconditional present-tense "Retrying… attempt
 *  N / M" gated on nothing but `attempts > 0`, so once App's backoff ladder stopped scheduling attempts
 *  the screen went on promising a retry that would never come — the user's only cue said "in progress"
 *  while the meeting sat unwritten. A status line may only claim work that is actually pending; when the
 *  ladder has given up it names the Save chip instead, which is armed in exactly this state. */
export function saveStatusLine(attempts: number, max: number, gaveUp: boolean): string | null {
  if (gaveUp) return 'Automatic retries have stopped. Press Save to try again.'
  if (attempts > 0) return `Retrying… attempt ${Math.min(attempts, max)} / ${max}`
  return null
}

/** Cold Calling Mode — whether the coaching notes' "People to invite or send to" section actually names
 *  anyone, so the "Book meetings" action is never offered against an empty section or a "None." verdict.
 *  Line-based (not a single regex): a blank line separating the heading from the next "## " section is
 *  itself whitespace, so a naive `\s*` boundary swallows it and misreads the FOLLOWING section as this
 *  one's body. */
export function coldCallHasPeopleToFollowUp(coachingText: string): boolean {
  const lines = coachingText.split(/\r?\n/)
  const start = lines.findIndex((l) => /^##\s*People to invite or send to\s*:?\s*$/i.test(l.trim()))
  if (start === -1) return false
  const body: string[] = []
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) body.push(lines[i])
  const text = body.join('\n').trim()
  return text.length > 0 && !/^none\.?$/i.test(text)
}
