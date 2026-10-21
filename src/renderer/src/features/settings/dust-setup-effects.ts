/**
 * dust-setup-effects.ts — the two background effects of the Dust setup card, moved out of DustSetup.tsx unchanged:
 * the RFC 8628 device-code poll that runs while the browser consent step is open, and the one-time live probe
 * of a CLI-origin connection when Settings opens.
 */
import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import type { PublicSettings } from '@shared/ipc'
import { decideDustLiveCheck } from '../../lib/dust-live-check'
import { DUST_CREDENTIAL_STORE } from './credential-store'

/** 'starting' covers CLI install + device-code mint. 'waiting' polls dustLoginPoll until the browser consent finishes. */
export type DustOAuthPhase = 'idle' | 'starting' | 'waiting' | 'picking' | 'finishing' | 'error'

export type DustOAuthState = {
  phase: DustOAuthPhase
  userCode: string | null
  verificationUri: string | null
  intervalSec: number
  expiresAt: number
  workspaces: Array<{ sId: string; name: string; role?: string }> | null
  error: string | null
}

export const DUST_OAUTH_IDLE: DustOAuthState = {
  phase: 'idle',
  userCode: null,
  verificationUri: null,
  intervalSec: 5,
  expiresAt: 0,
  workspaces: null,
  error: null
}

/**
 * Poll at the server-given cadence while waiting for the user to finish the browser step. RFC 8628:
 * 'pending' keeps the same interval, 'slow_down' adds 5s, anything else ends the loop.
 */
export function useDustOAuthPolling(oauth: DustOAuthState, setOauth: Dispatch<SetStateAction<DustOAuthState>>): void {
  useEffect(() => {
    if (oauth.phase !== 'waiting') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async (intervalSec: number): Promise<void> => {
      if (cancelled) return
      if (Date.now() > oauth.expiresAt) {
        setOauth((o) => (o.phase === 'waiting' ? { ...o, phase: 'error', error: 'Sign-in expired. Try again.' } : o))
        return
      }
      const r = await window.toto.dustLoginPoll()
      if (cancelled) return
      if (r.status === 'pending') {
        timer = setTimeout(() => void tick(intervalSec), intervalSec * 1000)
      } else if (r.status === 'slow_down') {
        timer = setTimeout(() => void tick(intervalSec), (intervalSec + 5) * 1000)
      } else if (r.status === 'ok') {
        setOauth((o) => (o.phase === 'waiting' ? { ...o, phase: 'picking', workspaces: r.workspaces ?? [] } : o))
      } else {
        setOauth((o) =>
          o.phase === 'waiting' ? { ...o, phase: 'error', error: r.error || 'Dust sign-in failed.' } : o
        )
      }
    }
    timer = setTimeout(() => void tick(oauth.intervalSec), oauth.intervalSec * 1000)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // Re-armed only when the phase enters 'waiting' — not on every render. (The device code that used to
    // key this lives in main now and never reaches the renderer.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oauth.phase])
}

// Live session probe on open. When the settings look connected VIA THE CLI, don't take that at face
// value — the underlying Dust CLI session can be gone (the user ran `dust logout`, the keychain was
// cleared, or the token is unrecoverable). Probe once per mount with the READ-ONLY dustProbeSession —
// NOT dustImportCli, which runs `dust status` and would rotate the OAuth token in a race with the
// concurrent loadAgents() above, 401-ing the agent list. Then act on decideDustLiveCheck:
//   • connected             → nothing to do.
//   • needs-access          → the keychain read was blocked; ask to allow it, DON'T relaunch setup.
//   • finish-workspace-pick → the browser OAuth step finished but the separate terminal
//                             workspace-picker step didn't; point back at that Terminal, DON'T relaunch.
//   • run-setup             → no live session behind the saved connection → auto-run install +
//                             `dust login` (Terminal), so the user is prompted to reconnect instead of
//                             silently assuming done.
// Gated to CLI-origin connections (dustSessionOrigin, set only by the CLI import/refresh — the OAuth
// login sets 'oauth'): a MANUAL API-key or native-OAuth connection legitimately has NO `dust-cli`
// keychain item, so probing it would misread as "dead" for no reason. The OAuth path's own on-401
// self-heal (main/index.ts's makeRefreshDustAuth) covers its equivalent case on next use.
export function useDustLiveSessionCheck({
  keySaved,
  hasWs,
  settings,
  setCli,
  setErr
}: {
  keySaved: boolean
  hasWs: boolean
  settings: Pick<PublicSettings, 'dustTokenMintedAt' | 'dustSessionOrigin'>
  setCli: (cli: { busy: boolean; msg: string | null; ok: boolean }) => void
  setErr: (err: string | null) => void
}): void {
  const liveCheckedRef = useRef(false)
  useEffect(() => {
    if (
      liveCheckedRef.current ||
      !keySaved ||
      !hasWs ||
      !settings.dustTokenMintedAt ||
      settings.dustSessionOrigin !== 'cli'
    )
      return
    liveCheckedRef.current = true
    void (async () => {
      const decision = decideDustLiveCheck(await window.toto.dustProbeSession())
      if (decision === 'connected') return
      if (decision === 'needs-access') {
        const msg = `Allow Métis to read your Dust CLI session in ${DUST_CREDENTIAL_STORE}, then Reconnect.`
        setCli({ busy: false, ok: false, msg })
        setErr(msg)
        return
      }
      if (decision === 'finish-workspace-pick') {
        const msg =
          'Almost there. Finish picking your workspace in the terminal from `dust login` (arrow keys, then Enter), then Reconnect.'
        setCli({ busy: false, ok: false, msg })
        setErr(msg)
        return
      }
      // decision === 'run-setup' — the saved CLI session is dead. Nudge toward a fix rather than silently
      // relaunching anything: there is no more in-app installer/terminal step for the CLI path to reopen.
      const msg =
        'Your Dust CLI session ended. Run `dust login` again and Reconnect, or use the automatic sign-in above.'
      setCli({ busy: false, ok: false, msg })
      setErr(msg)
    })()
    // Probe once on mount for the already-connected case only; connectCli / disconnect handle the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
