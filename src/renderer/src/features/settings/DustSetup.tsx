import { useEffect, useId, useRef, useState } from 'react'
import {
  AlertCircle,
  ChevronDown,
  CircleCheck,
  Info,
  Link2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Wand2,
  X
} from 'lucide-react'
import { DUST_BASE_AGENT_ID, type DustAgent, type ProfileRecoveryResult, type PublicSettings } from '@shared/ipc'
import { dustStoredAgentMissing, parseDustUrl, type ProviderId } from '@shared/providers'
import {
  DUST_EMPTY_AGENTS_ERROR,
  DUST_WORKSPACE_MISSING_SETUP_ERROR,
  decideDustInstantValidate,
  formatDustConnectedMessage,
  proveDustConnection,
  type DustInstantValidateResult
} from '@shared/dust-validate'
import { AgentStatus, InlineOrb } from '../../components/AgentStatus'
import { decideDustLiveCheck } from '../../lib/dust-live-check'
import { ctl } from '../../ui/ctl'
import { ManagedChip, managedChipCls } from '../../ui/ManagedChip'
import { Section } from '../../ui/Section'
import { StepBadge } from '../../ui/StepBadge'
import { AgentPicker } from './AgentPicker'
import { DUST_CREDENTIAL_STORE, PROFILE_CREDENTIAL_STORE, isProfileUnlockError } from './credential-store'
import { pickReadyProvider } from './provider-readiness'

export function DustSetup({
  settings,
  patch,
  saveKey,
  recoverEncryptedProfile,
  clearKey,
  active
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
  saveKey: (provider: ProviderId, k: string) => Promise<void>
  recoverEncryptedProfile: () => Promise<ProfileRecoveryResult>
  clearKey: (provider: ProviderId) => Promise<void>
  active: boolean
}): JSX.Element {
  const [link, setLink] = useState('')
  const [dustKey, setDustKey] = useState('')
  const [keySaving, setKeySaving] = useState(false)
  const [recoveryBusy, setRecoveryBusy] = useState(false)
  const [recoveryAvailable, setRecoveryAvailable] = useState(false)
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null)
  const [agents, setAgents] = useState<DustAgent[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [cli, setCli] = useState<{ busy: boolean; msg: string | null; ok: boolean }>({
    busy: false,
    msg: null,
    ok: false
  })
  // Native OAuth sign-in after the managed Dust CLI is installed. 'starting' covers CLI install +
  // device-code mint. 'waiting' polls dustLoginPoll until the browser consent finishes.
  type DustOAuthPhase = 'idle' | 'starting' | 'waiting' | 'picking' | 'finishing' | 'error'
  const [oauth, setOauth] = useState<{
    phase: DustOAuthPhase
    userCode: string | null
    verificationUri: string | null
    intervalSec: number
    expiresAt: number
    workspaces: Array<{ sId: string; name: string; role?: string }> | null
    error: string | null
  }>({
    phase: 'idle',
    userCode: null,
    verificationUri: null,
    intervalSec: 5,
    expiresAt: 0,
    workspaces: null,
    error: null
  })
  const linkId = useId()
  const wsId = useId()
  const thinkSel = useId()
  // The manual API-key path is collapsed by default so the one-click "Set up Dust automatically" button
  // is the obvious choice; users who already hold an admin key expand it.
  const [showKeyPath, setShowKeyPath] = useState(false)

  const isEu = /eu\.dust\.tt/i.test(settings.dustBaseUrl)
  // The one-click CLI setup (dustImportCli/dustSetupCli) is cross-platform now (dust-secret-store reads
  // the session on macOS/Windows/Linux), so it's the primary path on every OS — no per-platform gating.
  const locked = settings.managedKeys.includes('provider')
  // Same independent-key gap as the provider tiles: allowedProviders can restrict Dust without also
  // locking the 'provider' managed key — badge those controls "Restricted" rather than letting a save
  // activate a provider every ask would then reject.
  const orgAllowed = settings.allowedProviders
  const dustAllowed = !orgAllowed || orgAllowed.includes('dust')
  // Base agent is user-editable (picker below, defaults to the Métis agent, one-click reset) —
  // gated by the same 'providerModels' managed-key as the Advanced base-model field in AiSection, not
  // by the CLI-connection lock above. Spotlight Ref stays hard-locked (DUST_SPOTLIGHT_REF_AGENT_ID in
  // ipc.ts) — read-only display. The base agent also drafts meeting follow-ups directly — there is no
  // separate follow-up agent.
  const agentsLocked = settings.managedKeys.includes('providerModels')
  const agent = settings.providerModels['dust'] ?? ''
  const thinkAgent = settings.providerModelsThinking['dust'] ?? ''
  const spotlightAgent = settings.providerModelsSpotlightRef['dust'] ?? ''
  const keySaved = !!settings.hasKeys['dust']
  const hasWs = !!settings.dustWorkspaceId.trim()
  // Credentials on disk are not a live proof — green Connected / Use Dust wait for a non-empty agent list.
  const listProved = !!agents && agents.length > 0 && !err
  const connected = keySaved && hasWs && !!agent && listProved
  const selectedAgentName = agents?.find((a) => a.sId === agent)?.name
  const selectedAgent = agents?.find((a) => a.sId === agent)
  // Loaded the workspace's agents but the saved base agent isn't among them — the root cause of the
  // "Failed to retrieve agent message" ask failure. Warn + guide a one-click re-pick right at the picker.
  const storedAgentMissing = dustStoredAgentMissing(agent, agents)
  const spotlightAgentMissing = dustStoredAgentMissing(spotlightAgent, agents)
  const selectedAgentRunsSonnet = !!selectedAgent && selectedAgent.modelProviderId === 'anthropic' && /sonnet/i.test(selectedAgent.modelId || '')

  const applyDustValidate = (verdict: DustInstantValidateResult): void => {
    if (verdict.ok) {
      setCli({ busy: false, ok: true, msg: verdict.message })
      setErr(null)
      return
    }
    setCli({ busy: false, ok: false, msg: verdict.message })
    setErr(verdict.message)
  }

  // Live-ping after OAuth finish / CLI import (key already persisted in main). testApiKey + listDustAgents
  // (view:'list'); empty/restricted/401/dead session is not Connected. Never auto-sends a chat.
  const proveAfterConnect = async (workspaceId: string, selectedAgentId = agent): Promise<DustInstantValidateResult> => {
    const verdict = await proveDustConnection({
      workspaceId,
      selectedAgentId,
      testApiKey: () => window.toto.testApiKey('dust', ''),
      listAgents: () => loadAgents()
    })
    applyDustValidate(verdict)
    return verdict
  }

  // Import an existing `dust login` CLI session (token + workspace + region) from the keychain — the
  // migration path for a user who already has the CLI installed. The primary path is startDustOAuth below,
  // which installs the managed Dust CLI then signs in (native OAuth). No system Node.js.
  const connectCli = async (): Promise<void> => {
    setCli({ busy: true, msg: null, ok: false })
    const r = await window.toto.dustImportCli()
    if (!r.ok) {
      // Blocked Keychain read, not a missing session — ask to allow access, same as the mount-time live
      // check below (decideDustLiveCheck), instead of misdirecting into a needless re-login.
      if (r.accessDenied) {
        setCli({
          busy: false,
          ok: false,
          msg: r.error || `Allow Métis to access your Dust CLI session in ${DUST_CREDENTIAL_STORE}, then try again.`
        })
        return
      }
      if (r.incomplete) {
        // `dust login`'s browser OAuth step finished but its separate interactive terminal
        // workspace-picker step never did — point back at that terminal instead of retrying blind.
        setCli({
          busy: false,
          ok: false,
          msg: 'Almost there. Finish picking your workspace in the terminal from `dust login` (arrow keys, then Enter). Then click Import again.'
        })
        return
      }
      setCli({
        busy: false,
        ok: false,
        msg: r.error || 'No Dust CLI session found. Run `dust login` in a terminal first, or use the automatic sign-in above.'
      })
      return
    }
    // Import set key/workspace/region in main; make Dust active + refresh. If the CLI session belongs
    // to a DIFFERENT workspace than before, a previously-picked base/thinking agent sId is meaningless
    // there — reset both to the defaults instead of carrying a foreign workspace's agent across.
    const wsChanged = !!settings.dustWorkspaceId && !!r.workspaceId && settings.dustWorkspaceId !== r.workspaceId
    if (wsChanged) {
      const nextThinking = { ...settings.providerModelsThinking }
      delete nextThinking.dust
      await patch({
        provider: 'dust',
        providerModels: { ...settings.providerModels, dust: DUST_BASE_AGENT_ID },
        providerModelsThinking: nextThinking
      })
    } else {
      await patch({ provider: 'dust' })
    }
    setCli({ busy: false, ok: false, msg: 'Checking Dust connection…' })
    await proveAfterConnect(r.workspaceId || settings.dustWorkspaceId, wsChanged ? DUST_BASE_AGENT_ID : agent)
  }

  const oauthIdle = { phase: 'idle' as const, userCode: null, verificationUri: null, intervalSec: 5, expiresAt: 0, workspaces: null, error: null }

  // Step 1: mint a device code, open the browser consent page. Step 2 (polling) is the effect below.
  const startDustOAuth = async (): Promise<void> => {
    setOauth({ ...oauthIdle, phase: 'starting' })
    const installed = await window.toto.dustInstallCli()
    if (!installed.ok) {
      setOauth({
        ...oauthIdle,
        phase: 'error',
        error: installed.error || 'Could not install the Dust CLI.'
      })
      return
    }
    const r = await window.toto.dustLoginBegin()
    // The device code deliberately never reaches the renderer — main keeps it and polls with its own
    // copy (see the dustLoginBegin handler). The user code is what this screen actually needs.
    if (!r.ok || !r.userCode) {
      setOauth({ ...oauthIdle, phase: 'error', error: r.error || 'Could not start Dust sign-in.' })
      return
    }
    setOauth({
      phase: 'waiting',
      userCode: r.userCode ?? null,
      verificationUri: r.verificationUri ?? null,
      intervalSec: r.intervalSec || 5,
      expiresAt: Date.now() + (r.expiresInSec || 300) * 1000,
      workspaces: null,
      error: null
    })
  }

  // Poll at the server-given cadence while waiting for the user to finish the browser step. RFC 8628:
  // 'pending' keeps the same interval, 'slow_down' adds 5s, anything else ends the loop.
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
        setOauth((o) => (o.phase === 'waiting' ? { ...o, phase: 'error', error: r.error || 'Dust sign-in failed.' } : o))
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

  // Step 3: the user picked a workspace — finish the login and load its agents.
  const pickDustWorkspace = async (sId: string): Promise<void> => {
    setOauth((o) => ({ ...o, phase: 'finishing' }))
    const r = await window.toto.dustLoginPickWorkspace(sId)
    if (!r.ok) {
      setOauth((o) => ({ ...o, phase: 'error', error: r.error || 'Could not finish sign-in.' }))
      return
    }
    setOauth(oauthIdle)
    await patch({ provider: 'dust' })
    const verdict = await proveAfterConnect(sId)
    if (!verdict.ok) {
      setOauth({ ...oauthIdle, phase: 'error', error: verdict.message })
    }
  }

  // Save a Dust API key (manual alternative to the CLI). Dust keeps its own key, independent of the
  // raw-provider key field — so Dust stays self-contained whatever the active provider is.
  const saveDustKey = async (): Promise<void> => {
    const k = dustKey.trim()
    if (!k) return
    const workspaceId = settings.dustWorkspaceId.trim()
    setKeySaving(true)
    setErr(null)
    setRecoveryMessage(null)
    try {
      if (!workspaceId) {
        applyDustValidate({
          ok: false,
          reason: 'workspace-missing',
          message: DUST_WORKSPACE_MISSING_SETUP_ERROR
        })
        return
      }
      // Prove the pasted key before persisting it — a bad key must fail in this card, not look Saved.
      const test = await window.toto.testApiKey('dust', k)
      if (!test.ok) {
        applyDustValidate(decideDustInstantValidate({ workspaceId, test, list: test }, agent))
        return
      }
      await saveKey('dust', k)
      await patch({ provider: 'dust' }) // activate Dust so this key is used + the add-key CTA hides
      setDustKey('')
      setRecoveryAvailable(false)
      const list = await loadAgents()
      applyDustValidate(decideDustInstantValidate({ workspaceId, test, list }, agent))
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not save the Dust API key.'
      setErr(message)
      setRecoveryAvailable(isProfileUnlockError(message))
    } finally {
      setKeySaving(false)
    }
  }

  const recoverProfileAndRetryDustKey = async (): Promise<void> => {
    setRecoveryBusy(true)
    setRecoveryMessage(null)
    try {
      const result = await recoverEncryptedProfile()
      if (!result.ok) {
        setRecoveryMessage(result.canceled ? 'Recovery canceled. Your encrypted profile was not changed.' : result.error || 'Could not create a new local profile.')
        return
      }
      setRecoveryAvailable(false)
      setErr(null)
      await saveDustKey()
    } catch (e) {
      setRecoveryMessage(e instanceof Error ? e.message : 'Could not create a new local profile.')
    } finally {
      setRecoveryBusy(false)
    }
  }
  // Fully disconnect Dust: clear the saved token/key, drop the workspace + region + the (user-editable)
  // thinking agent, reset the (also user-editable) base agent back to the Métis default, switch off
  // Dust if it's active, and reset the local CLI/agents UI so the card returns to its "connect" state.
  // Used by the CLI card's Disconnect button only — the manual key's Remove uses the narrower
  // removeDustKey below, which doesn't touch workspace/region/base/thinking agent.
  const disconnectDust = async (): Promise<void> => {
    await clearKey('dust')
    const nextThinking = { ...settings.providerModelsThinking }
    delete nextThinking.dust
    // Base is now user-changeable, so disconnect restores it to the Métis default rather than leaving
    // a stale custom agent id pointing at a workspace you just disconnected from. Spotlight Ref is left
    // untouched — it's a hard-locked app default, not user data.
    const next: Partial<PublicSettings> = {
      dustWorkspaceId: '',
      dustBaseUrl: 'https://dust.tt',
      providerModels: { ...settings.providerModels, dust: DUST_BASE_AGENT_ID },
      providerModelsThinking: nextThinking,
      // Reset to the "never CLI-connected" default (0) — otherwise a stale CLI-origin timestamp survives
      // into a later manual-API-key connect and wrongly gates the live-check effect into probing a real
      // Dust CLI session that was never used for that connection (see the effect's own gating comment).
      dustTokenMintedAt: 0
    }
    if (settings.provider === 'dust')
      next.provider = pickReadyProvider(
        'dust',
        settings.hasKeys,
        settings.cliConnected ?? {},
        settings.dustWorkspaceId,
        settings.providerModels,
        settings.allowedProviders
      )
    await patch(next)
    setAgents(null)
    setErr(null)
    setCli({ busy: false, msg: null, ok: false })
  }
  // Remove just the saved Dust API key (Step 3's "Remove") — mirrors AiSection.onRemove. Leaves the
  // workspace, region, and thinking-agent choice untouched, unlike the full disconnectDust reset above.
  const removeDustKey = async (): Promise<void> => {
    await clearKey('dust')
    if (settings.provider === 'dust')
      await patch({
        provider: pickReadyProvider(
          'dust',
          settings.hasKeys,
          settings.cliConnected ?? {},
          settings.dustWorkspaceId,
          settings.providerModels,
          settings.allowedProviders
        )
      })
    // Mirror disconnectDust's reset: a cleared key means any previously loaded agent list/error is stale.
    setAgents(null)
    setErr(null)
  }
  const useDust = (): void => void patch({ provider: 'dust' })

  // Paste any Dust link → auto-fill workspace + region, and — since the base agent is user-editable —
  // an assistant link's agent id also becomes the base agent (the most direct "use THIS agent" gesture).
  const onLink = (v: string): void => {
    setLink(v)
    const p = parseDustUrl(v)
    const next: Partial<PublicSettings> = {}
    if (p.workspaceId) next.dustWorkspaceId = p.workspaceId
    if (p.baseUrl) next.dustBaseUrl = p.baseUrl
    if (p.agentId) next.providerModels = { ...settings.providerModels, dust: p.agentId }
    if (Object.keys(next).length) patch(next)
  }

  const loadAgents = async (): Promise<{ ok: boolean; agents?: DustAgent[]; error?: string }> => {
    setLoading(true)
    setErr(null)
    const r = await window.toto.dustListAgents()
    setLoading(false)
    if (r.ok && r.agents && r.agents.length > 0) {
      setAgents(r.agents)
      return r
    }
    const error = r.error || (r.ok ? DUST_EMPTY_AGENTS_ERROR : 'Could not load your agents. Check the key + workspace, then retry.')
    setAgents(r.ok && r.agents ? r.agents : null)
    setErr(error)
    return { ok: false, error, agents: r.agents }
  }

  // When Dust was already connected in a prior session (key + workspace saved), load the agent list on
  // mount — otherwise reopening Settings shows raw agent sIds instead of names and the Thinking-agent
  // control degrades from a dropdown to a bare text input until a manual refresh.
  useEffect(() => {
    if (keySaved && hasWs && agents === null && !loading) void loadAgents()
    // loadAgents is stable enough for this mount-on-connect check; re-run only when connection state flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keySaved, hasWs])

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
  const liveCheckedRef = useRef(false)
  useEffect(() => {
    if (liveCheckedRef.current || !keySaved || !hasWs || !settings.dustTokenMintedAt || settings.dustSessionOrigin !== 'cli') return
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
        const msg = 'Almost there. Finish picking your workspace in the terminal from `dust login` (arrow keys, then Enter), then Reconnect.'
        setCli({ busy: false, ok: false, msg })
        setErr(msg)
        return
      }
      // decision === 'run-setup' — the saved CLI session is dead. Nudge toward a fix rather than silently
      // relaunching anything: there is no more in-app installer/terminal step for the CLI path to reopen.
      const msg = 'Your Dust CLI session ended. Run `dust login` again and Reconnect, or use the automatic sign-in above.'
      setCli({ busy: false, ok: false, msg })
      setErr(msg)
    })()
    // Probe once on mount for the already-connected case only; connectCli / disconnect handle the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Editing the workspace ID string doesn't flip keySaved/hasWs (both stay true switching workspace A → B),
  // so the effect above never re-fires — without this, the Thinking-agent dropdown keeps showing workspace
  // A's stale agents. Invalidate on every edit; the button above ("Load my agents"/"Refresh") reloads.
  useEffect(() => {
    setAgents(null)
    setErr(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.dustWorkspaceId])

  const setThinkAgent = (sId: string): void =>
    patch({ providerModelsThinking: { ...settings.providerModelsThinking, dust: sId.trim() } })

  // Commits directly on every change, same as setThinkAgent — the select never offers an empty option,
  // and the text-input fallback's onBlur (below) catches a still-blank field and restores the default
  // there instead of fighting the user's edit on every keystroke. The base agent must never persist
  // blank: isDustReady() (and every task that cascades into Dust) requires providerModels.dust to be set.
  const setBaseAgent = (sId: string): void =>
    patch({ providerModels: { ...settings.providerModels, dust: sId.trim() } })

  const regionBtn = (eu: boolean): string =>
    [
      'no-drag cl-focus flex-1 rounded-[8px] border px-3 py-2 text-[12px] font-medium transition-colors',
      isEu === eu
        ? 'border-[var(--cl-primary)] bg-[var(--cl-primary-soft)] text-[color:var(--cl-foreground)]'
        : 'border-[var(--cl-border)] bg-white/[0.02] text-[color:var(--cl-muted-foreground)] hover:bg-white/[0.05]'
    ].join(' ')

  return (
    <Section
      title={active ? 'Dust CLI · Your agents (active)' : 'Dust CLI · Your agents'}
      desc="Your Dust agents (Second Brain retrieval + tools) power Métis. Connect with the Dust CLI, then pick a thinking agent for hard questions."
      icon={Link2}
    >
      <div className="flex flex-col gap-4">
        {/* PRIMARY — install the managed Dust CLI, then native OAuth (main/dust-oauth.ts). One
            click installs @dust-tt/dust-cli into userData and opens the browser for consent. */}
        <div className="flex flex-col gap-2 rounded-[12px] border border-[var(--cl-primary)]/40 bg-[var(--cl-primary-soft)]/50 p-3.5">
          {keySaved && hasWs ? (
            // Credentials exist → Reconnect / Disconnect. Green Connected only after a live agent list.
            <div className="flex items-center justify-between gap-2">
              <span
                className={[
                  'flex items-center gap-1.5 text-[12px] font-medium',
                  err || (agents && agents.length === 0)
                    ? 'text-[color:var(--cl-destructive)]'
                    : listProved
                      ? 'text-[color:var(--cl-success)]'
                      : 'text-[color:var(--cl-muted-foreground)]'
                ].join(' ')}
              >
                {err || (agents && agents.length === 0) ? (
                  <>
                    <AlertCircle size={14} />
                    {err || DUST_EMPTY_AGENTS_ERROR}
                  </>
                ) : listProved && agents ? (
                  <>
                    <CircleCheck size={14} />
                    {formatDustConnectedMessage({
                      agentCount: agents.length,
                      selectedName: selectedAgentName,
                      selectedId: agent,
                      workspaceId: settings.dustWorkspaceId
                    })}
                  </>
                ) : loading ? (
                  <>
                    <InlineOrb kind="connecting" />
                    Checking Dust connection…
                  </>
                ) : (
                  <>
                    <Info size={14} />
                    Workspace saved. Load agents to verify the connection.
                  </>
                )}
              </span>
              <div className="flex items-center gap-2">
                {locked && <span className={managedChipCls}>Managed by your organization</span>}
                <button
                  type="button"
                  onClick={() => void startDustOAuth()}
                  disabled={oauth.phase !== 'idle' || locked}
                  title="Sign in again to Dust"
                  className="no-drag cl-focus flex items-center gap-1.5 rounded-[8px] bg-[var(--cl-primary)] px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  {oauth.phase !== 'idle' ? <InlineOrb kind="connecting" /> : <RefreshCw size={13} />}
                  Reconnect
                </button>
                <button
                  type="button"
                  onClick={disconnectDust}
                  disabled={oauth.phase !== 'idle' || (locked && active)}
                  title="Disconnect Dust from Métis"
                  className="no-drag cl-focus flex items-center gap-1.5 rounded-[8px] border border-[var(--cl-destructive)]/30 bg-[var(--cl-destructive)]/10 px-3 py-1.5 text-[12px] font-medium text-[color:var(--cl-destructive)] hover:bg-[var(--cl-destructive)]/20 disabled:opacity-50"
                >
                  <X size={13} />
                  Disconnect
                </button>
              </div>
            </div>
          ) : oauth.phase === 'waiting' ? (
            // Waiting on the browser consent step — show the code in case the browser needs it re-typed,
            // and a way out in case the user closed the tab or the browser never opened.
            <div className="flex flex-col items-center gap-2 text-center">
              <AgentStatus kind="connecting" size="hero" />
              <span className="text-[13px] font-medium text-[color:var(--cl-foreground)]">Waiting for you to finish in your browser…</span>
              {oauth.userCode && (
                <span className="rounded-[8px] bg-black/20 px-3 py-1 font-mono text-[15px] tracking-widest text-[color:var(--cl-foreground)]">
                  {oauth.userCode}
                </span>
              )}
              {oauth.verificationUri && (
                <a
                  href={oauth.verificationUri}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-[color:var(--cl-primary)] underline"
                >
                  Browser didn&apos;t open? Click here
                </a>
              )}
              <button
                type="button"
                onClick={() => setOauth(oauthIdle)}
                className="no-drag cl-focus text-[11px] text-[color:var(--cl-muted-foreground)] underline"
              >
                Cancel
              </button>
            </div>
          ) : oauth.phase === 'picking' ? (
            // Workspace list from the just-finished sign-in — Métis's own picker replaces dust-cli's
            // arrow-key terminal UI.
            <div className="flex flex-col gap-2">
              <span className="text-center text-[12px] font-medium text-[color:var(--cl-foreground)]">Pick your workspace</span>
              {(oauth.workspaces ?? []).map((w) => (
                <button
                  key={w.sId}
                  type="button"
                  onClick={() => void pickDustWorkspace(w.sId)}
                  className="no-drag cl-focus flex items-center justify-between rounded-[8px] border border-[var(--cl-border)] bg-black/10 px-3 py-2 text-left text-[13px] text-[color:var(--cl-foreground)] hover:border-[var(--cl-primary)]"
                >
                  <span>{w.name}</span>
                  {w.role && <span className="text-[11px] text-[color:var(--cl-muted-foreground)]">{w.role}</span>}
                </button>
              ))}
            </div>
          ) : oauth.phase === 'finishing' ? (
            <div className="flex items-center justify-center gap-2 py-2 text-[13px] text-[color:var(--cl-muted-foreground)]">
              <AgentStatus kind="connecting" size="inline" caption />
            </div>
          ) : (
            <>
              <button
                type="button"
                onClick={() => void startDustOAuth()}
                disabled={oauth.phase === 'starting' || locked}
                className="no-drag cl-focus flex w-full items-center justify-center gap-2 rounded-[10px] bg-[var(--cl-primary)] px-4 py-3 text-[14px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                {oauth.phase === 'starting' ? <InlineOrb kind="connecting" /> : <Wand2 size={16} />}
                {oauth.phase === 'starting' ? 'Installing Dust CLI…' : 'Set up Dust automatically'}
              </button>
              <span className="text-center text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
                Installs the Dust CLI, then opens your browser to sign in and pick your workspace.
                {locked && <span className={'ml-1 ' + managedChipCls}>Managed by your organization</span>}
              </span>
              <button
                type="button"
                onClick={() => void connectCli()}
                disabled={cli.busy || locked}
                className="no-drag cl-focus mx-auto flex items-center gap-1.5 text-[11px] text-[color:var(--cl-muted-foreground)] underline disabled:opacity-50"
              >
                {cli.busy && <InlineOrb kind="connecting" />}
                Already signed in with the Dust CLI? Import that session
              </button>
            </>
          )}
          {oauth.error && (
            <span className="text-center text-[11px] text-[color:var(--cl-destructive)]">{oauth.error}</span>
          )}
          {cli.msg && (
            <span
              className={[
                'text-center text-[11px]',
                cli.ok ? 'text-[color:var(--cl-success)]' : 'text-[color:var(--cl-destructive)]'
              ].join(' ')}
            >
              {cli.msg}
            </span>
          )}
        </div>

        {recoveryAvailable && (
          <div className="flex flex-col gap-2 rounded-[10px] border border-[var(--cl-primary)]/35 bg-[var(--cl-primary-soft)]/40 p-3 text-[12px]">
            <div className="flex items-start gap-1.5 text-[color:var(--cl-foreground)]">
              <ShieldCheck size={13} className="mt-0.5 shrink-0 text-[color:var(--cl-primary)]" />
              <span>
                Métis cannot unlock the existing encrypted profile. Restore {PROFILE_CREDENTIAL_STORE} access and
                retry, or create a fresh local profile while the old encrypted data is preserved.
              </span>
            </div>
            <button
              type="button"
              onClick={() => void recoverProfileAndRetryDustKey()}
              disabled={recoveryBusy}
              className="no-drag cl-focus inline-flex w-fit items-center gap-1.5 rounded-[8px] bg-[var(--cl-primary)] px-3 py-1.5 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {recoveryBusy ? <InlineOrb kind="loading" /> : <RotateCcw size={13} />}
              {recoveryBusy ? 'Creating new profile…' : 'Create new local profile & retry'}
            </button>
            {recoveryMessage && <div className="text-[11px] text-[color:var(--cl-muted-foreground)]">{recoveryMessage}</div>}
          </div>
        )}

        {/* Manual alternative — collapsed by default. Everything the automatic setup does, by hand:
            paste a Dust link (auto-fills workspace + region) or an admin API key. */}
        <button
          type="button"
          onClick={() => setShowKeyPath((v) => !v)}
          aria-expanded={showKeyPath}
          className="no-drag cl-focus flex items-center gap-1.5 self-start text-[12px] font-medium text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-foreground)]"
        >
          <ChevronDown size={13} className={showKeyPath ? 'transition-transform' : '-rotate-90 transition-transform'} />
          I already have an API key
        </button>
        {showKeyPath && (
        <div className="flex flex-col gap-4">
        {/* Step 1 — paste a link, everything auto-fills */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 text-[12px] font-medium text-[color:var(--cl-foreground)]">
            <StepBadge n={1} done={hasWs} /> Paste any Dust link
          </div>
          <div className="relative">
            <Link2
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[color:var(--cl-muted-foreground)]"
            />
            <input
              id={linkId}
              value={link}
              onChange={(e) => onLink(e.target.value)}
              placeholder="Paste your Dust workspace or agent URL (fills the fields below)"
              className={'w-full min-w-0 max-w-full pl-7 ' + ctl}
            />
          </div>
          <span className="pl-7 text-[11px] text-[color:var(--cl-muted-foreground)]">
            e.g. https://dust.tt/w/<b>abc123</b>/builder/agents/<b>myAgent</b>, or fill the fields below.
          </span>
        </div>

        {/* Step 2 — workspace + region (auto, but editable) */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 text-[12px] font-medium text-[color:var(--cl-foreground)]">
            <StepBadge n={2} done={hasWs} /> Workspace &amp; region
          </div>
          <label htmlFor={wsId} className="sr-only">
            Workspace ID
          </label>
          <div className="flex items-center gap-2">
            <input
              id={wsId}
              value={settings.dustWorkspaceId}
              onChange={(e) => patch({ dustWorkspaceId: e.target.value })}
              placeholder="Workspace ID (e.g. abc123)"
              disabled={settings.managedKeys.includes('dustWorkspaceId')}
              className={
                'flex-1 min-w-0 ' + ctl + (settings.managedKeys.includes('dustWorkspaceId') ? ' opacity-60' : '')
              }
            />
            <ManagedChip keys={settings.managedKeys} k="dustWorkspaceId" />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => patch({ dustBaseUrl: 'https://dust.tt' })}
              disabled={settings.managedKeys.includes('dustBaseUrl')}
              className={regionBtn(false) + (settings.managedKeys.includes('dustBaseUrl') ? ' opacity-60 cursor-not-allowed' : '')}
            >
              US · dust.tt
            </button>
            <button
              type="button"
              onClick={() => patch({ dustBaseUrl: 'https://eu.dust.tt' })}
              disabled={settings.managedKeys.includes('dustBaseUrl')}
              className={regionBtn(true) + (settings.managedKeys.includes('dustBaseUrl') ? ' opacity-60 cursor-not-allowed' : '')}
            >
              EU · eu.dust.tt
            </button>
          </div>
          <ManagedChip keys={settings.managedKeys} k="dustBaseUrl" />
        </div>

        {/* Step 3 — Dust API key (self-contained — only needed if you didn't use the CLI above) */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 text-[12px] font-medium text-[color:var(--cl-foreground)]">
            <StepBadge n={3} done={keySaved} /> Dust API key
          </div>
          {keySaved ? (
            <div className="flex items-center justify-between gap-2 pl-7">
              <span className="flex items-center gap-1.5 text-[11px] text-[color:var(--cl-success)]">
                <CircleCheck size={13} /> Saved on this device.
              </span>
              <button
                type="button"
                onClick={removeDustKey}
                disabled={locked && active}
                className="no-drag cl-focus rounded-[8px] border border-[var(--cl-destructive)]/30 bg-[var(--cl-destructive)]/10 px-2.5 py-1 text-[11px] text-[color:var(--cl-destructive)] hover:bg-[var(--cl-destructive)]/20 disabled:opacity-50"
              >
                Remove
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 pl-7">
              <input
                type="password"
                value={dustKey}
                onChange={(e) => setDustKey(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveDustKey()}
                placeholder="Paste your Dust API key (sk-…)"
                className={'flex-1 ' + ctl}
              />
              <button
                type="button"
                onClick={saveDustKey}
                disabled={keySaving || !dustKey.trim() || (locked && active)}
                className="no-drag cl-focus flex items-center gap-1 rounded-[10px] bg-[var(--cl-primary)] px-3 py-2.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {keySaving ? <InlineOrb kind="loading" /> : null} Save
              </button>
              {locked ? (
                <span className={managedChipCls}>Managed by your organization</span>
              ) : (
                !dustAllowed && <span className={managedChipCls}>Restricted by your organization</span>
              )}
            </div>
          )}
          <span className="pl-7 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
            Get one at dust.tt → Settings → API Keys (admin). Or use “Set up Dust automatically” above,
            no key needed.
          </span>
        </div>
        </div>
        )}

        {/* Step 4 — pick the agent from a live list (no ids to copy) */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-[12px] font-medium text-[color:var(--cl-foreground)]">
              <StepBadge n={4} done={!!agent} /> Pick your agents
            </div>
            <button
              type="button"
              onClick={() =>
                void (async () => {
                  const list = await loadAgents()
                  const test = await window.toto.testApiKey('dust', '')
                  applyDustValidate(decideDustInstantValidate({ workspaceId: settings.dustWorkspaceId, test, list }, agent))
                })()
              }
              disabled={loading || !keySaved || !hasWs}
              title={!keySaved || !hasWs ? 'Save your key + workspace first' : 'Load your Dust agents'}
              className="no-drag cl-focus flex items-center gap-1 rounded-[8px] border border-[var(--cl-input)] bg-white/[0.04] px-2.5 py-1.5 text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.08] disabled:opacity-40"
            >
              {loading ? <InlineOrb kind="searching" /> : <RefreshCw size={13} />}
              {agents ? 'Refresh' : 'Load my agents'}
            </button>
          </div>

          {/* Base agent — answers everyday questions and drafts meeting follow-ups directly (no separate
              follow-up agent). User-editable via the AgentPicker popup below (keeping the current sId
              selectable even if it's not in the workspace), a bare sId input before the list loads, and
              a one-click reset back to the Métis default whenever it's been changed. The picker never
              offers an empty option, so the base agent can never persist empty. Locked by the same
              'providerModels' managed-key as the Advanced base-model field in AiSection above. */}
          <div className="flex flex-col gap-1">
            <span className="flex items-center justify-between text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
              <span className="flex items-center gap-1.5">
                Base agent · answers everyday questions &amp; drafts follow-ups
                <ManagedChip keys={settings.managedKeys} k="providerModels" />
              </span>
              {agent && agent !== DUST_BASE_AGENT_ID && (
                <button
                  type="button"
                  onClick={() => setBaseAgent(DUST_BASE_AGENT_ID)}
                  disabled={agentsLocked}
                  className="no-drag cl-focus rounded px-1 text-[11px] text-[color:var(--cl-primary)] hover:underline disabled:opacity-50"
                >
                  Reset to Métis default
                </button>
              )}
            </span>
            {storedAgentMissing && (
              <div className="flex items-start gap-1.5 rounded-[8px] border border-[var(--cl-destructive)]/30 bg-[var(--cl-destructive)]/10 px-2.5 py-1.5 text-[11px] leading-snug text-[color:var(--cl-destructive)]">
                <Info size={13} className="mt-0.5 shrink-0" />
                <span>Your saved agent is not in this workspace anymore. Pick one below so asks and Spotlight Ref work again.</span>
              </div>
            )}
            <AgentPicker
              label="Base agent"
              value={agent}
              agents={agents}
              loading={loading}
              err={err}
              onSelect={setBaseAgent}
              placeholder="Base agent id (defaults to Métis)"
              disabled={agentsLocked}
              defaultId={DUST_BASE_AGENT_ID}
              onEmptyBlur={() => setBaseAgent(DUST_BASE_AGENT_ID)}
            />
            {selectedAgent && (
              <div className={selectedAgentRunsSonnet ? 'text-[11px] text-[var(--cl-success)]' : 'text-[11px] text-[color:var(--cl-muted-foreground)]'}>
                {selectedAgentRunsSonnet
                  ? `Agent reports model: Anthropic ${selectedAgent.modelId}`
                  : `This agent reports ${selectedAgent.modelProviderId || 'an unknown provider'} ${selectedAgent.modelId || 'with no model id'}, not Anthropic Sonnet. It will still work, replies may just differ in tone or quality.`}
              </div>
            )}
          </div>

          {/* Thinking agent — used for hard/coding questions & Think mode. Still yours to pick. */}
          <label htmlFor={thinkSel} className="mt-1 text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
            Thinking agent · hard, coding questions · optional
          </label>
          <AgentPicker
            id={thinkSel}
            label="Thinking agent"
            value={thinkAgent}
            agents={agents}
            loading={loading}
            err={err}
            onSelect={setThinkAgent}
            placeholder="Thinking agent id (optional, defaults to base)"
            emptyOption="Same as base agent"
          />

          {/* Spotlight Ref agent is also hard-locked — not a picker. Same read-only pattern as base. */}
          <div className="mt-1 flex flex-col gap-1">
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
              Spotlight Ref agent · finds sales references for the live use case
              <span className={managedChipCls}>Managed by your organization</span>
            </span>
            {spotlightAgentMissing && (
              <div className="flex items-start gap-1.5 rounded-[8px] border border-[var(--cl-destructive)]/30 bg-[var(--cl-destructive)]/10 px-2.5 py-1.5 text-[11px] leading-snug text-[color:var(--cl-destructive)]">
                <Info size={13} className="mt-0.5 shrink-0" />
                <span>The Spotlight Ref agent is not in this workspace.</span>
              </div>
            )}
            <div className={'w-full opacity-60 ' + ctl}>
              {spotlightAgent ? agents?.find((a) => a.sId === spotlightAgent)?.name ?? spotlightAgent : 'Not configured yet'}
            </div>
          </div>
        </div>

        {/* Live status + activation */}
        <div
          className={[
            'cl-card flex items-center justify-between gap-2 px-3 py-2.5 text-[12px]',
            storedAgentMissing || (err && keySaved && hasWs)
              ? 'text-[color:var(--cl-destructive)]'
              : connected
                ? 'text-[color:var(--cl-success)]'
                : 'text-[color:var(--cl-muted-foreground)]'
          ].join(' ')}
        >
          <span className="flex items-center gap-2">
            {storedAgentMissing || (err && keySaved && hasWs) ? (
              <AlertCircle size={15} />
            ) : connected ? (
              <CircleCheck size={15} />
            ) : (
              <Info size={15} />
            )}
            {storedAgentMissing
              ? "The managed base agent isn't available in this workspace/region. Answers will fail. Check the pasted workspace and US/EU region."
              : err && keySaved && hasWs
                ? err
                : connected
                  ? `Workspace ${settings.dustWorkspaceId}. Base: ${selectedAgentName || agent}${
                      thinkAgent ? `, Thinking: ${agents?.find((a) => a.sId === thinkAgent)?.name || thinkAgent}` : ' (thinking → same as base)'
                    }.`
                  : loading && keySaved && hasWs
                    ? 'Checking Dust connection…'
                    : 'Connect from the Dust CLI above, or finish steps 1–4.'}
          </span>
          {storedAgentMissing ? null : active ? (
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-[var(--cl-primary-soft)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--cl-primary)]">
              <CircleCheck size={12} /> Active
            </span>
          ) : locked ? (
            <span className={managedChipCls}>Managed by your organization</span>
          ) : !dustAllowed ? (
            <span className={managedChipCls}>Restricted by your organization</span>
          ) : (
            connected && (
              <button
                type="button"
                onClick={useDust}
                className="no-drag cl-focus shrink-0 rounded-[8px] bg-[var(--cl-primary)] px-3 py-1.5 text-[11px] font-medium text-white hover:opacity-90"
              >
                Use Dust
              </button>
            )
          )}
        </div>
      </div>
    </Section>
  )
}
