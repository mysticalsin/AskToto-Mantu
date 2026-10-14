import type { CloudSpeechRouteSelection } from '@shared/cloud-speech'
import type { Track } from '@shared/contracts/speech'

export interface CloudSpeechConsentDialogProps {
  route: CloudSpeechRouteSelection
  tracks: Track[]
  onAccept: () => void
  onCancel: () => void
}

export function CloudSpeechConsentDialog({
  route,
  tracks,
  onAccept,
  onCancel
}: CloudSpeechConsentDialogProps): JSX.Element {
  const service =
    route.engine === 'deepgram-nova3'
      ? 'Deepgram Nova-3 through the Métis speech gateway'
      : 'Deepgram Nova-3 through Cloudflare Workers AI'
  const trackNames = tracks.map((track) => (track === 'microphone' ? 'microphone' : 'system audio'))

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/55 p-4" role="presentation">
      <section
        aria-labelledby="cloud-speech-consent-title"
        aria-modal="true"
        className="w-full max-w-md rounded-xl border border-white/15 bg-zinc-900 p-5 text-white shadow-2xl"
        role="dialog"
      >
        <h2 className="text-base font-semibold" id="cloud-speech-consent-title">
          Allow cloud speech transcription?
        </h2>
        <p className="mt-3 text-sm leading-6 text-white/80">
          Live {trackNames.join(' and ')} audio will be sent to {service} to produce this meeting’s transcript. This
          applies to this capture only.
        </p>
        <p className="mt-2 text-xs leading-5 text-white/60">
          Confirm that you have permission to share the selected audio, including other participants’ speech.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            className="rounded-md px-3 py-2 text-sm text-white/75 hover:bg-white/10"
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
          <button
            autoFocus
            className="rounded-md bg-white px-3 py-2 text-sm font-medium text-black hover:bg-white/90"
            onClick={onAccept}
            type="button"
          >
            Allow and start
          </button>
        </div>
      </section>
    </div>
  )
}
