import { useCallback, useRef, useState } from 'react'
import type { Track } from '@shared/contracts/speech'
import type { CloudSpeechEngine, CloudSpeechRouteSelection } from '@shared/cloud-speech'
import type { AudioSource } from './listen'
import { selectCloudSpeechStartRoute } from './cloud-speech-startup'
import { CLOUD_SPEECH_DISCLOSURE_VERSION } from '@shared/cloud-speech'
import type { CloudSpeechConsentAcknowledgement } from './cloud-speech-listen'
import { cloudSpeechConsentMatches } from './cloud-speech-listen'

export interface CloudSpeechConsentRequest {
  rescueExisting: boolean
  engine: CloudSpeechEngine
  source: AudioSource
  tracks: Track[]
  route: CloudSpeechRouteSelection
}

export interface CloudSpeechConsentAccepted {
  rescueExisting: boolean
  consent: CloudSpeechConsentAcknowledgement
}

export interface CloudSpeechConsentFlow {
  request: CloudSpeechConsentRequest | null
  cancel(): void
  accept(): CloudSpeechConsentAccepted | null
  authorizeSettingsStart(
    settings: { brokerSpeech?: { transport?: string; engine?: string }; audioSource?: AudioSource } | null,
    rescueExisting: boolean,
    consent?: CloudSpeechConsentAcknowledgement
  ): boolean
}

type CurrentSettingsRef = {
  current: {
    brokerSpeech?: { transport?: string; engine?: string }
    audioSource?: AudioSource
  } | null
}

export function useCloudSpeechConsent(settingsRef: CurrentSettingsRef, onNotice: (message: string) => void) {
  const [request, setRequest] = useState<CloudSpeechConsentRequest | null>(null)
  const checking = useRef(false)

  const begin = useCallback(
    (rescueExisting: boolean, engine: CloudSpeechEngine, source: AudioSource): void => {
      if (checking.current) return
      checking.current = true
      const tracks: Track[] =
        source === 'mic' ? ['microphone'] : source === 'system' ? ['system'] : ['microphone', 'system']
      void window.toto
        .cloudSpeechCapability()
        .then((capability) => {
          const latest = settingsRef.current
          if (
            latest?.brokerSpeech?.transport !== 'broker-v1' ||
            latest.brokerSpeech.engine !== engine ||
            (latest.audioSource ?? 'both') !== source
          ) {
            onNotice('Cloud speech settings changed. Start Listen again to review the current selection.')
            return
          }
          const selected = selectCloudSpeechStartRoute(capability, engine)
          if (!selected.ok) {
            onNotice(`Cloud speech is unavailable (${selected.code}). Listen did not start.`)
            return
          }
          setRequest({ rescueExisting, engine, source, tracks, route: selected.selected })
        })
        .catch(() => onNotice('Cloud speech readiness could not be verified. Listen did not start.'))
        .finally(() => {
          checking.current = false
        })
    },
    [settingsRef, onNotice]
  )

  const cancel = useCallback((): void => setRequest(null), [])
  const authorizeStart = useCallback(
    (
      transport: string | undefined,
      engine: string | undefined,
      source: AudioSource,
      rescueExisting: boolean,
      consent?: CloudSpeechConsentAcknowledgement
    ): boolean => {
      if (transport === 'refused') {
        onNotice('Cloud speech settings are invalid. Review the Audio settings before starting Listen.')
        return false
      }
      if (consent && transport !== 'broker-v1') {
        onNotice('Cloud speech settings changed. Start Listen again to review the current selection.')
        return false
      }
      if (transport !== 'broker-v1') return true
      if (!engine || engine === 'unconfigured') {
        onNotice('Choose a configured cloud speech engine before starting Listen.')
        return false
      }
      if (!consent) {
        begin(rescueExisting, engine as CloudSpeechEngine, source)
        return false
      }
      if (!cloudSpeechConsentMatches(engine, source, consent)) {
        onNotice('Cloud speech consent no longer matches the current engine and audio selection.')
        return false
      }
      return true
    },
    [begin, onNotice]
  )
  const authorizeSettingsStart = useCallback(
    (
      settings: { brokerSpeech?: { transport?: string; engine?: string }; audioSource?: AudioSource } | null,
      rescueExisting: boolean,
      consent?: CloudSpeechConsentAcknowledgement
    ): boolean =>
      authorizeStart(
        settings?.brokerSpeech?.transport,
        settings?.brokerSpeech?.engine,
        settings?.audioSource ?? 'both',
        rescueExisting,
        consent
      ),
    [authorizeStart]
  )
  const accept = useCallback((): { rescueExisting: boolean; consent: CloudSpeechConsentAcknowledgement } | null => {
    const current = request
    setRequest(null)
    if (!current) return null
    return {
      rescueExisting: current.rescueExisting,
      consent: {
        engine: current.engine,
        requestedTracks: [...current.tracks],
        disclosureVersion: CLOUD_SPEECH_DISCLOSURE_VERSION
      }
    }
  }, [request])

  return { request, begin, authorizeStart, authorizeSettingsStart, cancel, accept }
}
