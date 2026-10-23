export type SmokeReopenAction = 'park-window' | 'hide-window' | 'tray-show'

/** The packaged-smoke reopen probe's requested action from a second-instance command line, if it names one. */
export function smokeReopenAction(commandLine: readonly string[]): SmokeReopenAction | undefined {
  for (const arg of commandLine) {
    const match = arg.match(/^--metis-smoke-reopen=(park-window|hide-window|tray-show)$/)?.[1]
    if (match === 'park-window' || match === 'hide-window' || match === 'tray-show') return match
  }
  return undefined
}
