import { useEffect, useId, useRef, useState } from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'
import { emptyLicenseStatus, type IdentitySnapshot, type MemberActivateResult } from '@shared/ipc'
import { IdentityCard } from './IdentityCard'
import { prefersReducedMotion } from '../lib/identity-card-motion'

const ctl =
  'no-drag font-body cl-input cl-focus px-3 py-2.5 text-[13px] text-[color:var(--cl-foreground)] [color-scheme:dark]'

const LOADING: IdentitySnapshot = {
  installId: '',
  installedAt: '',
  installedAtLabel: 'Installed',
  memberNumber: null,
  memberNumberLabel: 'pending',
  deviceName: 'This device',
  serialKind: 'install',
  serialDisplay: 'pending',
  license: emptyLicenseStatus()
}

function activateCopy(r: MemberActivateResult | null): string | null {
  if (!r) return null
  if (r.error === 'activation_unavailable') {
    return 'Activation is not open yet. Métis checked the key and did not apply it.'
  }
  if (r.error === 'invalid') return 'Enter the license key you were given.'
  if (r.error === 'tampered' || r.error === 'wrong_kid') {
    return 'Personal. The saved license could not be verified.'
  }
  if (r.error) return 'Could not activate this license.'
  return null
}

export function IdentitySection(): JSX.Element {
  const keyId = useId()
  const reduced = prefersReducedMotion()
  const [snap, setSnap] = useState<IdentitySnapshot>(LOADING)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [importBusy, setImportBusy] = useState(false)
  const [result, setResult] = useState<MemberActivateResult | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    void window.toto.identitySnapshot().then((s) => {
      if (mounted.current) setSnap(s)
    })
    return () => {
      mounted.current = false
    }
  }, [])

  const runActivate = async (): Promise<void> => {
    const licenseKey = key.trim()
    if (!licenseKey) {
      setResult({
        ok: false,
        error: 'invalid',
        status: snap.license
      })
      return
    }
    setBusy(true)
    setResult(null)
    const r = await window.toto.memberLicenseActivate({ licenseKey })
    if (!mounted.current) return
    setBusy(false)
    setResult(r)
    setSnap((prev) => ({ ...prev, license: r.status }))
  }

  const runImport = async (): Promise<void> => {
    setImportBusy(true)
    setResult(null)
    const r = await window.toto.memberLicenseImportFile()
    if (!mounted.current) return
    setImportBusy(false)
    setResult(r)
    setSnap((prev) => ({ ...prev, license: r.status }))
  }

  const message = activateCopy(result)
  const caption = reduced
    ? 'This is your Métis member pass. Tap the pass to turn it over.'
    : 'This is your Métis member pass. Drag to turn it over. Arrow keys or Space also flip it.'

  return (
    <div className="metis-identity">
      <IdentityCard snapshot={snap} reducedMotion={reduced} />
      <p className="metis-identity-caption">{caption}</p>

      <section className="cl-card flex flex-col gap-3 px-4 py-4">
        <div>
          <div className="text-[13px] font-semibold leading-snug text-[color:var(--cl-foreground)]">License</div>
          <p className="mt-1 text-[12px] text-[color:var(--cl-muted-foreground)]">
            Activation is not open yet. A key you enter is checked, then returned unused.
          </p>
        </div>
        <div className="flex items-center justify-between gap-3 text-[12px]">
          <span className="text-[color:var(--cl-muted-foreground)]">State</span>
          <span className="font-medium text-[color:var(--cl-foreground)]">
            {snap.license.state === 'licensed' || snap.license.state === 'grace'
              ? snap.license.edition === 'enterprise'
                ? 'Enterprise'
                : snap.license.edition === 'pro'
                  ? 'Pro'
                  : 'Personal'
              : 'Personal'}
          </span>
        </div>
        <label htmlFor={keyId} className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">License key</span>
          <input
            id={keyId}
            type="password"
            value={key}
            spellCheck={false}
            autoComplete="off"
            placeholder="Paste the license key you were given"
            onChange={(e) => {
              setKey(e.target.value)
              setResult(null)
            }}
            className={`${ctl} w-full`}
          />
        </label>
        {message && (
          <div className="flex items-start gap-1.5 text-[11px] text-[color:var(--cl-foreground)]">
            <AlertCircle size={13} className="mt-px shrink-0 text-[color:var(--cl-primary)]" />
            <span>{message}</span>
          </div>
        )}
        <button
          type="button"
          onClick={() => void runActivate()}
          disabled={busy}
          className="no-drag cl-focus flex items-center justify-center gap-1.5 rounded-[10px] bg-[var(--cl-primary)] px-3 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-60"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : null}
          Activate
        </button>
        <button
          type="button"
          onClick={() => void runImport()}
          disabled={importBusy}
          className="no-drag cl-focus text-left text-[11px] text-[color:var(--cl-muted-foreground)] underline underline-offset-2 hover:text-[color:var(--cl-foreground)] disabled:opacity-60"
        >
          {importBusy ? 'Checking file…' : 'Choose a license.metis file. Activation is not open yet.'}
        </button>
      </section>
    </div>
  )
}
