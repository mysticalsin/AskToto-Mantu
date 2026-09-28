import { Component, type ReactNode } from 'react'

/** Only the illustrative preview is optional. Navigation remains outside this boundary. */
export class OnboardingDemoPreviewBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div role="alert" className="onboard-glass w-full max-w-[880px] p-5 text-center">
          <p className="m-0 font-semibold">This example could not be displayed.</p>
          <p className="mb-0 mt-2 text-[13px] text-[color:var(--color-ink-2)]">
            You can replay this step, move to the next example, or choose Set me up.
            Your setup has not been changed.
          </p>
        </div>
      )
    }
    return this.props.children
  }
}
