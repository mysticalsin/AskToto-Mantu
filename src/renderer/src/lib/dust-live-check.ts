/**
 * Decide what the Dust card should do after a *live* session probe, given that the persisted settings
 * already look connected (saved key + workspace + agent). Persisted state can lie: the user may have run
 * `dust logout`, cleared the keychain, or the CLI session may be gone — so opening Settings must verify
 * the real session instead of taking "already connected" for granted.
 *
 *  - `connected`            — the probe found a live session (token minted / read OK). Nothing to do.
 *  - `needs-access`         — the keychain read was BLOCKED (user hasn't allowed Métis to read the Dust
 *                             CLI item). The session likely still exists; prompt to allow + reconnect.
 *                             Do NOT re-run setup — reinstalling / re-logging-in here would be wrong and
 *                             pops a needless Terminal.
 *  - `finish-workspace-pick` — `dust login`'s browser OAuth step finished (access_token present) but its
 *                             separate interactive terminal workspace-picker step never did (workspace_sid
 *                             missing). The already-open Terminal is still waiting; relaunching setup here
 *                             would pop a SECOND window instead of pointing the user back at the first.
 *  - `run-setup`            — no live session behind the saved connection. Auto-run the install +
 *                             `dust login` setup so the user reconnects (Terminal), per the "detect +
 *                             auto-run" behavior.
 */
export type DustLiveProbe = { ok: boolean; accessDenied?: boolean; incomplete?: boolean }
export type DustLiveDecision = 'connected' | 'needs-access' | 'finish-workspace-pick' | 'run-setup'

export function decideDustLiveCheck(probe: DustLiveProbe): DustLiveDecision {
  if (probe.ok) return 'connected'
  if (probe.accessDenied) return 'needs-access'
  if (probe.incomplete) return 'finish-workspace-pick'
  return 'run-setup'
}
