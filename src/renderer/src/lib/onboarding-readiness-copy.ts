/** Setup can finish for transcription alone; AI-dependent features must be described separately. */
export function onboardingReadinessCopy(asrReady: boolean, aiReady: boolean): {
  title: string
  aiHint: string
  aiAction: string
} {
  return {
    title: !asrReady ? 'Finishing your setup…' : aiReady ? 'You’re all set.' : 'Transcription is ready.',
    aiHint: aiReady
      ? 'Your AI connection is configured. You can change it anytime in Settings.'
      : 'For automatic summaries and answers, connect AI in Settings. You can start with transcription only.',
    aiAction: aiReady ? 'Manage AI connection (optional)' : 'Set up AI for summaries and answers'
  }
}
