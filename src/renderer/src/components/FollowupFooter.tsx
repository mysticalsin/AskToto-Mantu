import { AppleCalendarAdd } from './AppleCalendarAdd'

/** Under the follow-up draft: the standing note, plus "Add to Apple Calendar" where EventKit is available. */
export function FollowupFooter({ title }: { title?: string }): React.JSX.Element {
  return (
    <>
      <AppleCalendarAdd title={title ? `Follow-up: ${title}` : 'Follow-up'} />
      <div className="text-[11px] text-[color:var(--color-ink-3)]">
        Review before sending. Outlook creates a draft only. Nothing sends itself.
      </div>
    </>
  )
}
