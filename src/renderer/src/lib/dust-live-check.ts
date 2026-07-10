/**
 * Decide what the Dust card should do after a *live* session probe, given that the persisted settings
 * already look connected (saved key + workspace + agent). Persisted state can lie: the user may have run
 * `dust logout`, cleared the keychain, or the CLI session may be gone — so opening Settings must verify
 * the real session instead of taking "already connected" for granted.
 *
 *  - `connected`    — the probe found a live session (token minted / read OK). Nothing to do.
 *  - `needs-access` — the keychain read was BLOCKED (user hasn't allowed Métis to read the Dust CLI item).
 *                     The session likely still exists; prompt to allow + reconnect. Do NOT re-run setup —
 *                     reinstalling / re-logging-in here would be wrong and pops a needless Terminal.
 *  - `run-setup`    — no live session behind the saved connection. Auto-run the install + `dust login`
 *                     setup so the user reconnects (Terminal), per the "detect + auto-run" behavior.
 */
export type DustLiveProbe = { ok: boolean; accessDenied?: boolean }
export type DustLiveDecision = 'connected' | 'needs-access' | 'run-setup'

export function decideDustLiveCheck(probe: DustLiveProbe): DustLiveDecision {
  if (probe.ok) return 'connected'
  if (probe.accessDenied) return 'needs-access'
  return 'run-setup'
}
