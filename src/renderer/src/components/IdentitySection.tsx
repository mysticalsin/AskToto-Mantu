import { useEffect, useState } from 'react'
import { emptyLicenseStatus, type IdentitySnapshot } from '@shared/ipc'
import { IdentityCard } from './IdentityCard'
import { prefersReducedMotion } from '../lib/identity-card-motion'

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

/** The pass is identity only. The adjacent Operator card owns the single verified activation flow. */
export function IdentitySection({ managedTier = null }: {
  managedTier?: 'metis' | 'metis-light' | null
}): JSX.Element {
  const reduced = prefersReducedMotion()
  const [snap, setSnap] = useState<IdentitySnapshot>(LOADING)

  useEffect(() => {
    let mounted = true
    void window.toto.identitySnapshot().then((s) => {
      if (mounted) setSnap(s)
    }).catch(() => {
      // A device-name lookup failure must not block licence activation.
    })
    return () => { mounted = false }
  }, [])

  const caption = reduced
    ? 'This is your Métis member pass. Tap the pass to turn it over.'
    : 'This is your Métis member pass. Drag to turn it over. Arrow keys or Space also flip it.'

  return (
    <div className="metis-identity">
      <IdentityCard snapshot={snap} managedTier={managedTier} reducedMotion={reduced} />
      <p className="metis-identity-caption">{caption}</p>
    </div>
  )
}
