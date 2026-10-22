/** Callbacks a queued job carries (live-save admission fences and receipt joins). Shared shape of `Job` in ingest.ts. */
export interface JobHooks {
  admissionChecks?: Array<() => void>
  settledCallbacks?: Array<() => void>
}

export function isJobAdmissionOpen(job: JobHooks): boolean {
  for (const check of job.admissionChecks ?? []) {
    try {
      check()
    } catch {
      return false
    }
  }
  return true
}

export function settleJobCallbacks(job: JobHooks): void {
  for (const callback of job.settledCallbacks ?? []) {
    try {
      callback()
    } catch {
      /* receipt settlement cannot fail ingest cleanup */
    }
  }
  job.settledCallbacks = []
}
