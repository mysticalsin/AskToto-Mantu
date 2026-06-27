import { useState } from 'react'
import { Loader2, ShieldCheck } from 'lucide-react'
import type { AuthStatus, SignInResult } from '@shared/ipc'
import { MantuLogo } from './MantuLogo'

function MsLogo({ size = 16 }: { size?: number }): JSX.Element {
  const g = size / 2 - 1
  return (
    <svg width={size} height={size} viewBox="0 0 21 21" aria-hidden="true">
      <rect x="0" y="0" width={g} height={g} fill="#F25022" />
      <rect x={g + 2} y="0" width={g} height={g} fill="#7FBA00" />
      <rect x="0" y={g + 2} width={g} height={g} fill="#00A4EF" />
      <rect x={g + 2} y={g + 2} width={g} height={g} fill="#FFB900" />
    </svg>
  )
}

/** Hard gate shown when Azure SSO is configured but the user is not signed in. Blocks all app use. */
export function SignInWall({
  status,
  onSignIn
}: {
  status: AuthStatus
  onSignIn: () => Promise<SignInResult>
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const go = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    const r = await onSignIn()
    setBusy(false)
    if (!r.ok) setErr(r.error || 'Sign-in failed.')
  }
  return (
    <div className="cl-root fade-up flex min-h-[280px] w-full flex-col items-center justify-center gap-5 rounded-2xl border border-[var(--cl-border)] p-8 text-center">
      <MantuLogo size={36} />
      <div className="flex flex-col gap-1.5">
        <div className="font-ui text-[18px] font-semibold text-[color:var(--cl-foreground)]">
          Sign in to use AskToto
        </div>
        <p className="max-w-[420px] text-[13px] leading-relaxed text-[color:var(--cl-muted-foreground)]">
          AskToto is restricted to your organization. Sign in with your{' '}
          <span className="text-[color:var(--cl-foreground)]">@{status.domain}</span> Microsoft
          account to continue.
        </p>
      </div>
      <button
        type="button"
        onClick={go}
        disabled={busy}
        className="no-drag cl-focus flex items-center justify-center gap-2 rounded-[10px] bg-[var(--cl-primary)] px-5 py-2.5 text-[14px] font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {busy ? <Loader2 size={16} className="animate-spin" /> : <MsLogo size={16} />}
        Sign in with Microsoft
      </button>
      {err && <div className="text-[12px] text-[color:var(--cl-destructive)]">{err}</div>}
      <div className="flex items-center gap-1.5 text-[11px] text-[color:var(--cl-muted-foreground)]">
        <ShieldCheck size={12} className="text-[color:var(--cl-primary)]" />
        Locked to your Mantu tenant · ties your usage to Dust.
      </div>
    </div>
  )
}
