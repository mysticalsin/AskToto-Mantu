/**
 * OperatorReportingSection.tsx — Settings › Privacy › Organisation reporting (owner decision 2026-10-21: every install
 * reports usage and health to the organisation's Operator, with no user opt-out; IT turns it off by policy).
 *
 * Apple HIG (Settings, Privacy): one plain sentence says what is shared, a detail line names every field, and the
 * status line says what is happening now. Nothing here asks the user to configure anything. The licence card, the
 * Operator address and a legacy secret stay available to IT under a collapsed "Advanced" disclosure.
 */
import { useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import type { PublicSettings } from '@shared/ipc'
import { OPERATOR_REPORTING_DETAIL, OPERATOR_REPORTING_DISCLOSURE } from '@shared/operator'
import { ctl } from '../../ui/ctl'
import { OperatorLicenseCard } from './OperatorLicenseCard'
import { OperatorUrlField } from './OperatorUrlField'
import { primaryBtnStyle } from './ProductConnections'

export type OperatorReportingState = NonNullable<PublicSettings['operatorReporting']>
export type OperatorReportingOrigin = 'admin' | 'sso' | 'token' | null

/** The one status line under the disclosure. An unknown state reads as "pending": enrolment retries on its own. */
export function operatorReportingStatusLine(status: PublicSettings['operatorReporting']): string {
  if (status === 'enrolled') return 'Connected'
  if (status === 'off-by-policy') return 'Turned off by your IT administrator'
  if (status === 'revoked') return 'This device was removed by your administrator'
  return 'Connects automatically when online'
}

/** Profile › Source line for this seat, or null when the device has not enrolled yet. */
export function operatorSourceLine(origin: OperatorReportingOrigin): string | null {
  if (origin === 'sso') return 'Organisation · SSO'
  if (origin === 'token') return 'Organisation · Automatic'
  if (origin === 'admin') return 'Organisation · Licence from IT'
  return null
}

/** Onboarding caption (scene `setup`): informational only, no checkbox, because reporting has no opt-out. */
export function OperatorReportingCaption({
  settings,
  visible
}: {
  settings: PublicSettings | null | undefined
  visible: boolean
}): JSX.Element | null {
  if (!visible || settings?.operatorReporting === 'off-by-policy') return null
  return (
    <p className="fade-up m-0 max-w-[360px] text-[11px] leading-snug text-[color:var(--color-ink-3)]">
      {OPERATOR_REPORTING_DISCLOSURE}
    </p>
  )
}

/** Profile tab: where this seat's Operator licence came from. Reads the reporting status once on mount. */
export function OperatorSourceLine(): JSX.Element | null {
  const [origin, setOrigin] = useState<OperatorReportingOrigin>(null)
  useEffect(() => {
    let live = true
    window.toto
      .operatorReportingStatus()
      .then((r) => live && setOrigin(r.origin))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  const line = operatorSourceLine(origin)
  if (!line) return null
  return <p className="m-0 px-1 text-[11px] text-[color:var(--cl-muted-foreground)]">Source: {line}</p>
}

export function OperatorReportingSection({
  settings,
  patch,
  reportedPatch,
  refreshSettings
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => Promise<PublicSettings>
  reportedPatch: (p: Partial<PublicSettings>) => Promise<PublicSettings> | void
  refreshSettings: () => Promise<void>
}): JSX.Element {
  const [secretDraft, setSecretDraft] = useState('')
  const [secretSaving, setSecretSaving] = useState(false)
  const [secretError, setSecretError] = useState<string | null>(null)
  const secretLocked = settings.managedKeys.includes('operatorIngestSecret')
  const saveOperatorSecret = async (): Promise<void> => {
    setSecretSaving(true)
    setSecretError(null)
    try {
      await patch({ operatorIngestSecret: secretDraft.trim() })
      setSecretDraft('')
    } catch {
      setSecretError('Could not save the connection. Try again.')
    } finally {
      setSecretSaving(false)
    }
  }
  const off = settings.operatorReporting === 'off-by-policy'

  return (
    <div className="flex flex-col gap-1">
      <p className="m-0 px-1 text-[12px] leading-relaxed text-[color:var(--cl-foreground)]">
        {OPERATOR_REPORTING_DISCLOSURE}
      </p>
      <p role="status" className="m-0 px-1 text-[12px] font-medium text-[color:var(--cl-foreground)]">
        {operatorReportingStatusLine(settings.operatorReporting)}
      </p>
      {!off && (
        <p className="m-0 px-1 text-[11px] leading-relaxed text-[color:var(--cl-muted-foreground)]">
          {OPERATOR_REPORTING_DETAIL}
        </p>
      )}
      {settings.operatorConfigured && (
        <button
          type="button"
          onClick={() => void window.toto.operatorOpen()}
          className="no-drag cl-focus mt-1 flex w-fit items-center gap-1 rounded-lg bg-white/[0.05] px-2.5 py-1.5 text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.1]"
        >
          <ExternalLink size={12} /> Open Operator
        </button>
      )}
      <details className="mt-1 px-1 py-1">
        <summary className="cl-focus text-[11px] text-[color:var(--cl-muted-foreground)]">
          Advanced: use a licence from IT
        </summary>
        <OperatorLicenseCard refreshSettings={refreshSettings} />
        <div className="mt-2">
          <OperatorUrlField
            value={settings.operatorUrl || ''}
            disabled={settings.managedKeys.includes('operatorUrl')}
            patch={reportedPatch}
          />
        </div>
        {settings.operatorLegacyCredentialConfigured && (
          <div className="mt-2">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
                Legacy ingest secret
              </span>
              <input
                type="password"
                value={secretDraft}
                spellCheck={false}
                autoComplete="off"
                placeholder="Connection saved. Enter a replacement to change it."
                disabled={secretSaving || secretLocked}
                onChange={(e) => setSecretDraft(e.target.value)}
                className={`${ctl} w-full`}
              />
            </label>
            <button
              type="button"
              className={`${primaryBtnStyle} mt-2`}
              disabled={!secretDraft.trim() || secretSaving || secretLocked}
              onClick={() => void saveOperatorSecret()}
            >
              {secretSaving ? 'Saving…' : 'Save connection'}
            </button>
            {secretError && (
              <p role="alert" className="mt-1 text-[11px] text-[color:var(--cl-destructive)]">
                {secretError}
              </p>
            )}
          </div>
        )}
      </details>
    </div>
  )
}
