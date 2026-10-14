import { useEffect, useState } from 'react'
import type { PublicSettings } from '@shared/ipc'
import type { CloudSpeechCapability } from '@shared/cloud-speech'
import { packageModeFromStateSnapshot, type ProductPackageMode } from '../../lib/package-profile-readiness'
import { cloudSpeechRowStatus } from '../../lib/cloud-speech-readiness'
import { createCloudSpeechRequestFence } from '../../lib/cloud-speech-request-fence'

type BrokerSettings = PublicSettings['brokerSpeech']

function routeLabel(engine: string): string {
  return engine === 'cloudflare-nova3'
    ? 'Cloudflare Workers AI · Nova-3'
    : 'Deepgram Nova-3 through Cloudflare AI Gateway'
}

export function CloudSpeechSection({
  settings,
  patch
}: {
  settings: PublicSettings
  patch: (value: Partial<PublicSettings>) => Promise<PublicSettings>
}): JSX.Element | null {
  const [packageMode, setPackageMode] = useState<ProductPackageMode>('invalid')
  const [capability, setCapability] = useState<CloudSpeechCapability | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)

  useEffect(() => {
    let current = true
    void window.toto
      .speechPackState()
      .then((snapshot) => {
        if (current) setPackageMode(packageModeFromStateSnapshot(snapshot))
      })
      .catch(() => {
        if (current) setPackageMode('invalid')
      })
    return () => {
      current = false
    }
  }, [])

  useEffect(() => {
    if (packageMode !== 'lean') return
    let current = true
    let lastCheckAt = 0
    const requestFence = createCloudSpeechRequestFence()
    const refresh = (): void => {
      if (Date.now() - lastCheckAt < 750) return
      lastCheckAt = Date.now()
      const requestId = requestFence.begin()
      setCapability(null)
      setLoadFailed(false)
      void window.toto
        .cloudSpeechCapability()
        .then((value) => {
          if (current && requestFence.isCurrent(requestId)) setCapability(value)
        })
        .catch(() => {
          if (current && requestFence.isCurrent(requestId)) setLoadFailed(true)
        })
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') refresh()
    }
    refresh()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      current = false
      requestFence.invalidate()
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [
    packageMode,
    settings.brokerSpeech.engine,
    settings.brokerSpeech.transport,
    settings.cloudSttProvider,
    settings.licenseValid,
    settings.licenseLastValidatedAt,
    settings.managedKeys.includes('brokerSpeech'),
    settings.managedKeys.includes('cloudSttProvider'),
    settings.enterpriseLive.managed,
    settings.enterpriseLive.inferenceMode,
    settings.enterpriseLive.summaryOnly
  ])

  if (packageMode !== 'lean') return null

  const allowed = capability?.allowed ?? []
  const currentEngine =
    settings.brokerSpeech.transport === 'broker-v1' && settings.brokerSpeech.engine !== 'unconfigured'
      ? settings.brokerSpeech.engine
      : null
  const selectedAllowed = currentEngine !== null && allowed.some((route) => route.engine === currentEngine)
  const routeLocked = settings.managedKeys.includes('brokerSpeech')
  const status = loadFailed
    ? { state: 'action' as const, detail: 'Cloud speech availability could not be checked.' }
    : saveFailed
      ? { state: 'action' as const, detail: 'The cloud speech route could not be saved.' }
      : cloudSpeechRowStatus(capability, currentEngine)

  const selectRoute = async (engine: string): Promise<void> => {
    if (!allowed.some((route) => route.engine === engine) || saving) return
    setSaving(true)
    setSaveFailed(false)
    try {
      await patch({ brokerSpeech: { transport: 'broker-v1', engine: engine as BrokerSettings['engine'] } })
    } catch {
      setSaveFailed(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="rounded-xl border border-[var(--cl-border)] bg-white/[0.02] p-3">
      <h3 className="text-[13px] font-medium text-[color:var(--cl-foreground)]">Cloud speech</h3>
      <p className="mt-1 text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]">
        Choose an approved hosted route. Métis does not ask for provider credentials here, and a route failure never
        switches to local inference.
      </p>
      <label className="mt-2 flex flex-col gap-1 text-[11px] text-[color:var(--cl-muted-foreground)]">
        Transcript route
        <select
          aria-label="Cloud speech route"
          value={selectedAllowed ? currentEngine : ''}
          disabled={saving || routeLocked || allowed.length === 0}
          onChange={(event) => void selectRoute(event.target.value)}
          className="w-full rounded border border-[var(--cl-input)] bg-[var(--cl-background)] px-2 py-1.5 text-[12px] text-[color:var(--cl-foreground)]"
        >
          <option value="" disabled>
            {allowed.length ? 'Choose an allowed route' : 'No route is currently allowed'}
          </option>
          {allowed.map((route) => (
            <option key={route.engine} value={route.engine}>
              {routeLabel(route.engine)}
            </option>
          ))}
        </select>
      </label>
      {routeLocked && (
        <p className="mt-1 text-[11px] text-[color:var(--cl-muted-foreground)]">Managed by your organization.</p>
      )}
      <p
        role={status.state === 'action' ? 'status' : undefined}
        className={`mt-2 text-[11px] ${status.state === 'ready' ? 'text-emerald-300' : 'text-[color:var(--cl-muted-foreground)]'}`}
      >
        {status.detail}
      </p>
      <p className="mt-1 text-[10px] text-[color:var(--cl-muted-foreground)]">
        Availability is checked when Settings opens or regains focus. Session start verifies current authorization and
        route policy again.
      </p>
      {capability && currentEngine && !selectedAllowed && (
        <p className="mt-1 text-[11px] text-amber-300">The saved route is not allowed by the current speech policy.</p>
      )}
      {capability &&
        capability.allowed.map((route) => (
          <p key={`${route.routeId}:${route.modelId}`} className="sr-only">
            {routeLabel(route.engine)} · {route.routeId} · {route.modelId}
          </p>
        ))}
    </section>
  )
}
