import { Panel } from './Panel'
import { useState } from 'react'

export function MacKeychainUnlockScreen(props: {
  setRoot: (element: HTMLDivElement | null) => void
  onUnlock: () => Promise<void>
}): JSX.Element {
  const [unlocking, setUnlocking] = useState(false)
  return (
    <div ref={props.setRoot} className="onboard-exclusive-lock flex h-full min-h-0 w-full items-center justify-center p-6">
      <Panel>
        <div className="m-auto flex max-w-sm flex-col items-center gap-3 px-4 py-5 text-center">
          <h1 className="m-0 text-[18px] font-semibold text-[color:var(--color-ink)]">Unlock secure storage</h1>
          <p className="m-0 text-[12px] leading-snug text-[color:var(--color-ink-3)]">
            Métis needs macOS secure storage before it can open or create this profile. Continue to let Métis request
            access to the Keychain. If macOS asks, approve access for Métis. Denying access leaves your files unchanged.
          </p>
          <button
            type="button"
            disabled={unlocking}
            onClick={() => {
              setUnlocking(true)
              void props.onUnlock().catch(() => undefined).finally(() => setUnlocking(false))
            }}
            className="no-drag focus-ring rounded-lg bg-[var(--color-accent)] px-3.5 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-60"
          >
            {unlocking ? 'Waiting for Keychain…' : 'Continue to Keychain'}
          </button>
        </div>
      </Panel>
    </div>
  )
}
