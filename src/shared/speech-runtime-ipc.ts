/** Channel names owned by the speech-runtime installer and private Whisper host contracts. */
export const SPEECH_RUNTIME_IPC = {
  speechPackAction: 'speech-pack:action',
  speechPackPlanPreview: 'speech-pack:plan-preview',
  speechPackInstallWithPlan: 'speech-pack:install-with-plan',
  runtimeInstallPlanPreview: 'runtime:install-plan-preview',
  runtimeInstallWithPlan: 'runtime:install-with-plan',
  runtimeWhisperWorkerOpen: 'runtime:whisper-worker-open',
  runtimeWhisperWorkerClose: 'runtime:whisper-worker-close',
  speechPackProgress: 'speech-pack:progress'
} as const
