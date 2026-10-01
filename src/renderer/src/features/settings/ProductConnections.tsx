import { useEffect, useId, useState } from 'react'
import { Check, AlertCircle, RefreshCw, Link2, CircleCheck, ChevronDown } from 'lucide-react'
import type { McpConnectionKind, PublicSettings } from '@shared/ipc'
import { ClickUpMark } from '../../components/brand/ClickUpMark'
import { PlaneMark } from '../../components/brand/PlaneMark'
import { InlineOrb } from '../../components/AgentStatus'
import { Section } from '../../ui/Section'
import { ctl } from '../../ui/ctl'

export function McpConnectionCard({
  settings,
  patch,
  kind,
  defaultLabel,
  title,
  desc,
  endpointPlaceholder,
  apiKeyHint,
  extraFields
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
  kind: McpConnectionKind
  defaultLabel: string
  title: string
  desc: string
  endpointPlaceholder: string
  apiKeyHint: string
  /** Extra transport-header inputs beyond the bearer key (e.g. Plane's X-Workspace-slug). Empty for a
   *  connection whose endpoint needs nothing beyond `Authorization: Bearer <key>` (BidStack). */
  extraFields?: { key: string; label: string; placeholder: string }[]
}): JSX.Element {
  const connectionId = kind
  const conn = settings.mcpConnections.find((c) => c.id === connectionId)
  const [open, setOpen] = useState(false)
  const [endpointUrl, setEndpointUrl] = useState(conn?.endpointUrl || '')
  const [apiKey, setApiKey] = useState('')
  const [extraValues, setExtraValues] = useState<Record<string, string>>(
    Object.fromEntries((extraFields ?? []).map((f) => [f.key, conn?.extraHeaders?.[f.key] || '']))
  )
  const [testState, setTestState] = useState<{
    phase: 'idle' | 'testing' | 'tested' | 'saving' | 'error'
    error: string | null
    tools: string[] | null
  }>({ phase: 'idle', error: null, tools: null })

  const connected = conn?.connected ?? false
  const endpointId = useId()
  const keyId = useId()

  const extraHeaders = (): Record<string, string> =>
    Object.fromEntries(Object.entries(extraValues).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]))

  const testConnection = async (): Promise<void> => {
    setTestState({ phase: 'testing', error: null, tools: null })
    const r = await window.toto.mcpTestConnection({
      connectionId,
      endpointUrl: endpointUrl.trim(),
      apiKey: apiKey.trim(),
      extraHeaders: extraHeaders()
    })
    if (r.ok) {
      setTestState({ phase: 'tested', error: null, tools: r.tools ?? [] })
    } else {
      setTestState({ phase: 'error', error: r.error || 'Could not connect.', tools: null })
    }
  }

  const saveConnection = async (): Promise<void> => {
    setTestState((s) => ({ ...s, phase: 'saving' }))
    const r = await window.toto.mcpSaveConnection({
      connectionId,
      endpointUrl: endpointUrl.trim(),
      apiKey: apiKey.trim(),
      extraHeaders: extraHeaders(),
      label: conn?.label || defaultLabel
    })
    if (r.ok) {
      await patch({
        mcpConnections: [
          ...settings.mcpConnections.filter((c) => c.id !== connectionId),
          {
            id: connectionId,
            kind,
            label: conn?.label || defaultLabel,
            endpointUrl: endpointUrl.trim(),
            connected: true,
            tools: r.tools ?? [],
            extraHeaders: extraHeaders()
          }
        ]
      })
      setApiKey('')
      setTestState({ phase: 'idle', error: null, tools: null })
      setOpen(false)
    } else {
      setTestState({ phase: 'error', error: r.error || 'Could not save the connection.', tools: null })
    }
  }

  const disconnect = async (): Promise<void> => {
    // MQA-091: main returns ok:false + an explanation when the on-disk key file survived the delete (a
    // locked/read-only key file). Discarding it told the user their credential was removed when it was not.
    const r = await window.toto.mcpDisconnect({ connectionId })
    await patch({
      mcpConnections: settings.mcpConnections.map((c) => (c.id === connectionId ? { ...c, connected: false, tools: [] } : c))
    })
    setEndpointUrl('')
    setApiKey('')
    if (!r.ok) {
      // Keep the panel open so the error strip below is on screen — the connection is off either way,
      // but the surviving key file needs a manual cleanup the user can only do if they're told.
      setTestState({ phase: 'error', error: r.error || 'Disconnected, but the stored key could not be removed.', tools: null })
      setOpen(true)
      return
    }
    setTestState({ phase: 'idle', error: null, tools: null })
    setOpen(false)
  }

  return (
    <div
      className={[
        'flex flex-col gap-2 rounded-[10px] border p-3',
        connected ? 'border-[var(--cl-primary)] bg-[var(--cl-primary-soft)]/40' : 'border-[var(--cl-border)] bg-white/[0.02]'
      ].join(' ')}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-[12px] font-medium text-[color:var(--cl-foreground)]">{title}</span>
          <span className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">{desc}</span>
        </div>
        {connected ? (
          <span className={activePillStyle}>
            <CircleCheck size={12} /> Connected
          </span>
        ) : null}
      </div>

      {connected && !open ? (
        <div className="flex items-center gap-3">
          <span className="min-w-0 flex-1 truncate text-[11px] text-[color:var(--cl-muted-foreground)]" title={conn?.endpointUrl}>
            {conn?.endpointUrl}
          </span>
          <button
            type="button"
            onClick={() => {
              setEndpointUrl(conn?.endpointUrl || '')
              setExtraValues(Object.fromEntries((extraFields ?? []).map((f) => [f.key, conn?.extraHeaders?.[f.key] || ''])))
              setOpen(true)
            }}
            className="no-drag cl-focus shrink-0 text-[11px] text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-foreground)]"
          >
            Reconnect
          </button>
          <button
            type="button"
            onClick={() => void disconnect()}
            className="no-drag cl-focus shrink-0 text-[11px] text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-destructive)]"
          >
            Disconnect
          </button>
        </div>
      ) : !open ? (
        <button type="button" onClick={() => setOpen(true)} className={secondaryBtnStyle}>
          <Link2 size={12} />
          Set up
        </button>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor={endpointId} className="text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
              MCP endpoint URL
            </label>
            <input
              id={endpointId}
              value={endpointUrl}
              onChange={(e) => {
                setEndpointUrl(e.target.value)
                setTestState({ phase: 'idle', error: null, tools: null })
              }}
              placeholder={endpointPlaceholder}
              className={'w-full ' + ctl}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={keyId} className="text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
              API key
            </label>
            <input
              id={keyId}
              type="password"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value)
                setTestState({ phase: 'idle', error: null, tools: null })
              }}
              placeholder={apiKeyHint}
              className={'w-full ' + ctl}
            />
          </div>

          {(extraFields ?? []).map((f) => {
            const fieldId = `${keyId}-${f.key}`
            return (
              <div key={f.key} className="flex flex-col gap-1">
                <label htmlFor={fieldId} className="text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
                  {f.label}
                </label>
                <input
                  id={fieldId}
                  value={extraValues[f.key] || ''}
                  onChange={(e) => {
                    setExtraValues((s) => ({ ...s, [f.key]: e.target.value }))
                    setTestState({ phase: 'idle', error: null, tools: null })
                  }}
                  placeholder={f.placeholder}
                  className={'w-full ' + ctl}
                />
              </div>
            )
          })}

          {testState.phase === 'error' && testState.error && (
            <div className="flex items-start gap-1.5 text-[11px] text-[color:var(--cl-destructive)]">
              <AlertCircle size={13} className="mt-px shrink-0" />
              <span>{testState.error}</span>
            </div>
          )}
          {testState.phase === 'tested' && testState.tools && (
            <div className="flex items-start gap-1.5 text-[11px] text-[color:var(--cl-success)]">
              <CircleCheck size={13} className="mt-px shrink-0" />
              <span>
                Connected.{' '}
                {testState.tools.length > 0
                  ? `Found ${testState.tools.length} tool${testState.tools.length === 1 ? '' : 's'}: ${testState.tools.join(', ')}`
                  : `${defaultLabel} reported no tools for this key’s scope.`}
              </span>
            </div>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void testConnection()}
              disabled={!endpointUrl.trim() || !apiKey.trim() || testState.phase === 'testing' || testState.phase === 'saving'}
              className={secondaryBtnStyle}
            >
              {testState.phase === 'testing' ? <InlineOrb kind="connecting" /> : <RefreshCw size={12} />}
              Test connection
            </button>
            <button
              type="button"
              onClick={() => void saveConnection()}
              disabled={testState.phase !== 'tested'}
              title={testState.phase !== 'tested' ? 'Test the connection successfully first' : undefined}
              className={primaryBtnStyle}
            >
              {testState.phase === 'saving' ? <InlineOrb kind="loading" /> : <Check size={12} />}
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                setApiKey('')
                setTestState({ phase: 'idle', error: null, tools: null })
              }}
              className={secondaryBtnStyle}
            >
              Cancel
            </button>
          </div>
          <span className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
            Request only the <code className="rounded bg-white/[0.08] px-1">mcp + write</code> scope. This is a
            push-only integration. The endpoint depends on where your {defaultLabel} backend runs; there's no
            default beyond the placeholder shown above.
          </span>
        </div>
      )}
    </div>
  )
}

// Shared button styles for McpConnectionCard (module scope — CliIntegration's own primaryBtn/secondaryBtn
// are local to that component and not exported, so this is a small deliberate duplicate, not a shared import).
export const primaryBtnStyle =
  'no-drag cl-focus flex items-center gap-1.5 rounded-[8px] bg-[var(--cl-primary)] px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50'
const secondaryBtnStyle =
  'no-drag cl-focus flex items-center gap-1.5 rounded-[8px] border border-[var(--cl-input)] bg-white/[0.04] px-3 py-1.5 text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.08] disabled:opacity-50'
export const activePillStyle =
  'flex shrink-0 items-center gap-1 rounded-full bg-[var(--cl-primary-soft)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--cl-primary)]'

/**
 * Product-connect card (ClickUp, Plane) — docs/design/BRAIN-CONNECTORS.md.
 * Default: official logo, name, one line, Connect. No URL / key / slug / Test / Save.
 * Advanced (closed on every mount): paste a key. Main pins the MCP URL.
 * Connect / Test / Save / Disconnect fire only from an explicit click — never a useEffect.
 */
function ProductConnectCard({
  settings,
  patch,
  kind,
  title,
  desc,
  waitingLabel,
  mark,
  connect,
  pinnedEndpoint,
  apiKeyHint,
  extraFields,
  operatorManaged
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
  kind: 'clickup' | 'plane'
  title: string
  desc: string
  waitingLabel: string
  mark: JSX.Element
  connect: () => Promise<{ ok: boolean; error?: string; tools?: string[]; clickupListId?: string; clickupListName?: string }>
  pinnedEndpoint: string
  apiKeyHint: string
  extraFields?: { key: string; label: string; placeholder: string }[]
  /** PLAN.md P2.2b #3: set when this seat has no local key for this connection but Operator supplies
   *  one (CRM push then uses it automatically). last4 of the Operator-delivered credential, never the
   *  credential itself. */
  operatorManaged?: { last4: string }
}): JSX.Element {
  const conn = settings.mcpConnections.find((c) => c.id === kind)
  const connected = conn?.connected ?? false
  const [state, setState] = useState<{
    phase: 'idle' | 'connecting' | 'testing' | 'tested' | 'saving' | 'error'
    error: string | null
    tools: string[] | null
  }>({ phase: 'idle', error: null, tools: null })
  const [advanced, setAdvanced] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [extraValues, setExtraValues] = useState<Record<string, string>>(
    Object.fromEntries((extraFields ?? []).map((f) => [f.key, conn?.extraHeaders?.[f.key] || '']))
  )
  const keyId = useId()

  const extraHeaders = (): Record<string, string> =>
    Object.fromEntries(Object.entries(extraValues).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]))

  const runConnect = async (): Promise<void> => {
    setState({ phase: 'connecting', error: null, tools: null })
    const r = await connect()
    if (r.ok) {
      await patch({
        mcpConnections: [
          ...settings.mcpConnections.filter((c) => c.id !== kind),
          {
            id: kind,
            kind,
            label: title,
            endpointUrl: pinnedEndpoint,
            connected: true,
            tools: r.tools ?? [],
            extraHeaders: extraHeaders(),
            ...(kind === 'clickup' && (r.clickupListId || r.clickupListName)
              ? { clickupListId: r.clickupListId, clickupListName: r.clickupListName }
              : {})
          }
        ]
      })
      setState({ phase: 'idle', error: null, tools: null })
    } else {
      setState({ phase: 'error', error: r.error || `Could not connect ${title}.`, tools: null })
    }
  }

  const testKey = async (): Promise<void> => {
    setState({ phase: 'testing', error: null, tools: null })
    const r = await window.toto.mcpTestConnection({
      connectionId: kind,
      endpointUrl: pinnedEndpoint,
      apiKey: apiKey.trim(),
      extraHeaders: extraHeaders()
    })
    if (r.ok) {
      setState({ phase: 'tested', error: null, tools: r.tools ?? [] })
    } else {
      setState({ phase: 'error', error: r.error || 'Could not connect.', tools: null })
    }
  }

  const saveKey = async (): Promise<void> => {
    setState((s) => ({ ...s, phase: 'saving' }))
    const r = await window.toto.mcpSaveConnection({
      connectionId: kind,
      endpointUrl: pinnedEndpoint,
      apiKey: apiKey.trim(),
      extraHeaders: extraHeaders(),
      label: title
    })
    if (r.ok) {
      await patch({
        mcpConnections: [
          ...settings.mcpConnections.filter((c) => c.id !== kind),
          {
            id: kind,
            kind,
            label: title,
            endpointUrl: pinnedEndpoint,
            connected: true,
            tools: r.tools ?? [],
            extraHeaders: extraHeaders(),
            ...(kind === 'clickup' && (r.clickupListId || r.clickupListName)
              ? { clickupListId: r.clickupListId, clickupListName: r.clickupListName }
              : {})
          }
        ]
      })
      setApiKey('')
      setAdvanced(false)
      setState({ phase: 'idle', error: null, tools: null })
    } else {
      setState({ phase: 'error', error: r.error || 'Could not save the connection.', tools: null })
    }
  }

  const disconnect = async (): Promise<void> => {
    const r = await window.toto.mcpDisconnect({ connectionId: kind })
    await patch({
      mcpConnections: settings.mcpConnections.map((c) => (c.id === kind ? { ...c, connected: false, tools: [] } : c))
    })
    setApiKey('')
    if (!r.ok) {
      setState({ phase: 'error', error: r.error || 'Disconnected, but cleanup failed.', tools: null })
      return
    }
    setState({ phase: 'idle', error: null, tools: null })
  }

  const connecting = state.phase === 'connecting'

  return (
    <div
      data-connector={kind}
      className={[
        'flex flex-col gap-2 rounded-[10px] border p-3',
        connected ? 'border-[var(--cl-primary)] bg-[var(--cl-primary-soft)]/40' : 'border-[var(--cl-border)] bg-white/[0.02]'
      ].join(' ')}
    >
      <div className="flex items-center gap-3">
        {connected ? (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-white/[0.06]">
            {mark}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => void runConnect()}
            disabled={connecting}
            aria-label={`Connect ${title}`}
            className="no-drag cl-focus flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-white/[0.06] hover:bg-white/[0.1] disabled:opacity-50"
          >
            {mark}
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-medium text-[color:var(--cl-foreground)]">{title}</div>
          <div className="text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">{desc}</div>
        </div>
        {connected ? (
          <span className={activePillStyle}>
            <CircleCheck size={12} /> Connected
          </span>
        ) : operatorManaged ? (
          <span className={activePillStyle} title="Métis Operator supplies this connection's credential; no local key is set.">
            <CircleCheck size={12} /> Managed by Operator ({operatorManaged.last4})
          </span>
        ) : (
          <button type="button" onClick={() => void runConnect()} disabled={connecting} className={primaryBtnStyle}>
            {connecting ? <InlineOrb kind="connecting" /> : null}
            {connecting ? waitingLabel : 'Connect'}
          </button>
        )}
      </div>

      {connected ? (
        <div className="flex items-center gap-3 pl-10">
          <span className="min-w-0 flex-1 truncate text-[11px] text-[color:var(--cl-muted-foreground)]">
            {conn && conn.tools.length > 0
              ? kind === 'clickup' && conn.clickupListName
                ? `Tasks go to ${conn.clickupListName}`
                : `${conn.tools.length} tool${conn.tools.length === 1 ? '' : 's'} available`
              : 'Connected. No tools reported for this account.'}
          </span>
          <button
            type="button"
            onClick={() => void runConnect()}
            disabled={connecting}
            className="no-drag cl-focus shrink-0 text-[11px] text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-foreground)]"
          >
            {connecting ? <InlineOrb kind="connecting" /> : 'Reconnect'}
          </button>
          <button
            type="button"
            onClick={() => void disconnect()}
            className="no-drag cl-focus shrink-0 text-[11px] text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-destructive)]"
          >
            Disconnect
          </button>
        </div>
      ) : null}

      {state.phase === 'error' && state.error && (
        <div className="flex items-start gap-1.5 text-[11px] text-[color:var(--cl-destructive)]">
          <AlertCircle size={13} className="mt-px shrink-0" />
          <span>{state.error}</span>
        </div>
      )}
      {state.phase === 'tested' && state.tools && (
        <div className="flex items-start gap-1.5 text-[11px] text-[color:var(--cl-success)]">
          <CircleCheck size={13} className="mt-px shrink-0" />
          <span>
            Connected.{' '}
            {state.tools.length > 0
              ? `Found ${state.tools.length} tool${state.tools.length === 1 ? '' : 's'}: ${state.tools.join(', ')}`
              : `${title} reported no tools for this key’s scope.`}
          </span>
        </div>
      )}

      <div>
        <button
          type="button"
          onClick={() => setAdvanced((o) => !o)}
          aria-expanded={advanced}
          className="no-drag cl-focus flex items-center gap-1 text-[11px] text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-foreground)]"
        >
          <ChevronDown size={12} className={advanced ? 'rotate-180' : ''} />
          Advanced
        </button>
        {advanced ? (
          <div className="mt-2 flex flex-col gap-2">
            <p className="text-[11px] text-[color:var(--cl-muted-foreground)]">Paste a key if you already have one.</p>
            <div className="flex flex-col gap-1">
              <label htmlFor={keyId} className="text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
                API key
              </label>
              <input
                id={keyId}
                type="password"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value)
                  setState((s) => ({ ...s, phase: s.phase === 'tested' ? 'idle' : s.phase, error: null, tools: null }))
                }}
                placeholder={apiKeyHint}
                className={'w-full ' + ctl}
              />
            </div>
            {(extraFields ?? []).map((f) => {
              const fieldId = `${keyId}-${f.key}`
              return (
                <div key={f.key} className="flex flex-col gap-1">
                  <label htmlFor={fieldId} className="text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
                    {f.label}
                  </label>
                  <input
                    id={fieldId}
                    value={extraValues[f.key] || ''}
                    onChange={(e) => {
                      setExtraValues((s) => ({ ...s, [f.key]: e.target.value }))
                      setState((s) => ({ ...s, phase: s.phase === 'tested' ? 'idle' : s.phase, error: null, tools: null }))
                    }}
                    placeholder={f.placeholder}
                    className={'w-full ' + ctl}
                  />
                </div>
              )
            })}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void testKey()}
                disabled={!apiKey.trim() || state.phase === 'testing' || state.phase === 'saving' || connecting}
                className={secondaryBtnStyle}
              >
                {state.phase === 'testing' ? <InlineOrb kind="connecting" /> : <RefreshCw size={12} />}
                Test connection
              </button>
              <button
                type="button"
                onClick={() => void saveKey()}
                disabled={state.phase !== 'tested'}
                title={state.phase !== 'tested' ? 'Test the connection successfully first' : undefined}
                className={primaryBtnStyle}
              >
                {state.phase === 'saving' ? <InlineOrb kind="loading" /> : <Check size={12} />}
                Save
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function ClickupCard({ settings, patch }: { settings: PublicSettings; patch: (p: Partial<PublicSettings>) => void }): JSX.Element {
  return (
    <ProductConnectCard
      settings={settings}
      patch={patch}
      kind="clickup"
      title="ClickUp"
      desc="Tasks from a recap. Nothing sends itself."
      waitingLabel="Waiting for ClickUp…"
      mark={<ClickUpMark size={28} />}
      connect={() => window.toto.mcpClickupConnect()}
      pinnedEndpoint="https://mcp.clickup.com/mcp"
      apiKeyHint="ClickUp API token (power option, Connect is the usual path)"
    />
  )
}

export function PlaneCard({ settings, patch }: { settings: PublicSettings; patch: (p: Partial<PublicSettings>) => void }): JSX.Element {
  // PLAN.md P2.2b #3: Plane is the one local CRM kind an Operator-supplied credential can stand in for
  // (see operatorCrmCredentialFor's doc comment on the desktop side for why clickup/bidstack are not).
  const [operatorPlane, setOperatorPlane] = useState<{ last4: string } | null>(null)
  useEffect(() => {
    let cancelled = false
    void window.toto.operatorStatus().then((status) => {
      if (cancelled) return
      const plane = status.integrations.find((i) => i.kind === 'plane' && i.hasCredential)
      setOperatorPlane(plane ? { last4: plane.last4 } : null)
    })
    return () => {
      cancelled = true
    }
  }, [settings.operatorIntegrationsVersion])

  return (
    <ProductConnectCard
      settings={settings}
      patch={patch}
      kind="plane"
      title="Plane"
      desc="Work items from a recap. Nothing sends itself."
      waitingLabel="Waiting for Plane…"
      mark={<PlaneMark size={28} />}
      connect={() => window.toto.mcpPlaneConnect()}
      pinnedEndpoint="https://mcp.plane.so/http/api-key/mcp"
      apiKeyHint="Personal or workspace access token"
      extraFields={[{ key: 'X-Workspace-slug', label: 'Workspace slug', placeholder: 'acme' }]}
      operatorManaged={operatorPlane ?? undefined}
    />
  )
}

export const OPERATOR_ENTITLEMENT_LABELS: Record<string, string> = {
  ask: 'Ask',
  listen: 'Listen',
  recap: 'Recap',
  crm_push: 'CRM push',
  operator_keys: 'Operator-funded providers',
  intelligence: 'Intelligence indexing',
  integrations: 'Integrations'
}
