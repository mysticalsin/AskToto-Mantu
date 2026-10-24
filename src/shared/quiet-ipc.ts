/** Quiet-mode (G68) IPC channels, kept out of ipc.ts so the shared contract file does not grow. */
export const QUIET_IPC = {
  policyGet: 'quiet:policy:get',
  outputOffer: 'quiet:output:offer',
  outputReleased: 'quiet:output:released'
} as const
