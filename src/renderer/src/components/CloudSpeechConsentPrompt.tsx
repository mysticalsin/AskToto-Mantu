import { CloudSpeechConsentDialog } from './CloudSpeechConsentDialog'
import type { CloudSpeechConsentAccepted, CloudSpeechConsentFlow } from '../lib/cloud-speech-consent'

export function CloudSpeechConsentPrompt({
  flow,
  onStart
}: {
  flow: CloudSpeechConsentFlow
  onStart(rescueExisting: boolean, consent: CloudSpeechConsentAccepted['consent']): void
}): JSX.Element | null {
  const { request } = flow
  if (!request) return null
  return (
    <CloudSpeechConsentDialog
      route={request.route}
      tracks={request.tracks}
      onCancel={flow.cancel}
      onAccept={() => {
        const accepted = flow.accept()
        if (accepted) onStart(accepted.rescueExisting, accepted.consent)
      }}
    />
  )
}
