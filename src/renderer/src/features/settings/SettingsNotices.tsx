/**
 * SettingsNotices.tsx — the two short lines Settings shows about a save and about Replay onboarding, kept out of
 * SettingsRoot.tsx so it stays under its size ceiling.
 */

/** One line at the top of the content pane for a write that could not be saved (cleared by the next success). */
export function SaveErrorLine({ message }: { message: string }): JSX.Element {
  return (
    <p
      role="alert"
      className="no-drag m-0 shrink-0 border-b border-[var(--cl-destructive)]/30 bg-[var(--cl-destructive)]/5 px-3.5 py-2 text-[12px] leading-snug text-[color:var(--cl-destructive)]"
    >
      {message}
    </p>
  )
}

/** Why Replay onboarding is dimmed: it would swap the window and end the meeting being listened to. */
export function ReplayHint({ id }: { id: string }): JSX.Element {
  return (
    <p id={id} className="m-0 mr-1 max-w-[190px] text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
      Available after you stop listening.
    </p>
  )
}
