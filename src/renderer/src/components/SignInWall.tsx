import { useState } from 'react'
import { Loader2, ShieldCheck, AlertCircle } from 'lucide-react'
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

/**
 * Turn a raw Entra sign-in error into one friendly, actionable line. The raw strings come from
 * main/auth.ts signIn() (timeout, wrong-tenant, wrong-domain) and from MSAL / the loopback server
 * (cancelled, no code, network). Keep the already-specific org/domain messages verbatim.
 */
function friendlyAuthError(raw: string, domainLabel: string): string {
  const e = raw.toLowerCase()
  if (/outside your organization/.test(e)) return `That account isn't part of ${domainLabel}. Pick your ${domainLabel} work account in the browser.`
  if (/use your @/.test(e)) return raw // already names the exact domain to use
  if (/timed out|timeout/.test(e)) return 'The sign-in window timed out or was closed. Click to try again.'
  if (/no authorization code|cancel|denied|access_denied/.test(e)) return 'Sign-in was cancelled before it finished. Click to try again.'
  if (/network|fetch failed|enotfound|econnrefused|getaddrinfo|offline|dns|socket|network_error/.test(e)) return 'Could not reach Microsoft. Check your connection and try again.'
  if (/invalid state/.test(e)) return "Sign-in couldn't be verified for security. Try again."
  return raw
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
  const domainLabel = status.domain ? `@${status.domain}` : 'your organization'
  const go = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    const r = await onSignIn()
    setBusy(false)
    if (!r.ok) setErr(friendlyAuthError(r.error || 'Sign-in failed.', domainLabel))
  }
  return (
    <div className="cl-root fade-up relative flex min-h-[360px] w-full flex-col items-center justify-center gap-7 overflow-hidden rounded-2xl border border-[var(--cl-border)] p-8 text-center">
      {/* Soft brand glow behind the logo — premium, on-brand, purely decorative. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-20 left-1/2 h-48 w-48 -translate-x-1/2 rounded-full bg-[color:var(--cl-primary)] opacity-20 blur-3xl"
      />

      <div className="relative flex flex-col items-center gap-5">
        <MantuLogo size={148} />
        <div className="flex flex-col gap-2">
          <div className="font-ui text-[19px] font-semibold tracking-tight text-[color:var(--cl-foreground)]">
            Sign in to Métis
          </div>
          <p className="max-w-[420px] text-[13px] leading-relaxed text-[color:var(--cl-muted-foreground)]">
            Your real-time meeting copilot. Sign in with your{' '}
            <span className="font-medium text-[color:var(--cl-foreground)]">{domainLabel}</span> Microsoft
            account to continue.
          </p>
        </div>

        <div className="flex w-full flex-col items-center gap-2.5">
          <button
            type="button"
            onClick={go}
            disabled={busy}
            className="no-drag cl-focus flex w-[280px] items-center justify-center gap-2.5 rounded-[12px] bg-[var(--cl-primary)] px-5 py-3 text-[14px] font-semibold text-white shadow-[0_6px_24px_-8px_var(--cl-primary)] transition hover:brightness-110 disabled:opacity-60"
          >
            {busy ? <Loader2 size={17} className="animate-spin" /> : <MsLogo size={18} />}
            {busy ? 'Waiting for your browser…' : 'Sign in with Microsoft'}
          </button>

          {busy && (
            <p className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
              A Microsoft window opened. Finish there, then come back.
            </p>
          )}

          {err && (
            <div className="flex max-w-[300px] items-start gap-2 rounded-[10px] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-left">
              <AlertCircle size={14} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
              <span className="text-[12px] leading-snug text-[var(--color-danger)]">{err}</span>
            </div>
          )}
        </div>
      </div>

      <div className="relative flex items-center gap-1.5 text-[11px] text-[color:var(--cl-muted-foreground)]">
        <ShieldCheck size={12} className="text-[color:var(--color-accent-text)]" />
        Only your Mantu Microsoft account can sign in. Transcription runs on your device.
      </div>
    </div>
  )
}
