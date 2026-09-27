declare const __METIS_QA_IDENTITY__: boolean

/**
 * True only in the QA-identity build: package.json's dist:qa-identity sets METIS_QA_IDENTITY=1, which
 * electron.vite.config.ts compiles in as a literal. Every branch it guards is dropped from shipping bytes, and
 * scripts/check-packaged-runtime.mjs proves it on each package.
 */
export const QA_IDENTITY_BUILD: boolean = __METIS_QA_IDENTITY__

/**
 * QA-identity builds only. SIGUSR2 raises a real uncaughtException, so the packaged exit-path proof
 * (scripts/qa/fault-fatal-relaunch.mjs) drives onFatal exactly as a production fault would.
 */
export function installQaFaultHook(): void {
  process.on('SIGUSR2', () => {
    throw new Error('METIS_QA_FAULT_HOOK: injected uncaughtException')
  })
}
