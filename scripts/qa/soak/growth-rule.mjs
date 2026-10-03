// Pre-registered growth rules for the hosted idle soak and the meeting hour (M2-0488).
//
// Written before any real data exists. RULES below is the registered data; growth-rule.contract.test.ts pins
// the sha256 of its canonical serialization, so any edit fails CI until a reviewed PR updates the pin and
// states why. A verdict whose rules sha256 differs from the registered one is not valid evidence.
// scripts/qa/soak/growth.mjs applies these rules to a census-stream/1 NDJSON (scripts/qa/census/run.mjs
// --ndjson) and its audit-counts/1 file (--audit-counts).
//
// Common definitions (both rules)
//   Samples     : one census sample every 30 s. Time is measured from the stream's first sample (the census
//                 start, which the idle leg takes as launch). A sample is complete when every process in it
//                 carries the platform's memory metric: macOS phys_footprint (physFootprintBytes), Windows
//                 private bytes (privateBytes). Only complete samples are used.
//   Kinds       : the census kinds listed in RULES, including 'sidecar-supervisor'. A process of any other
//                 kind is counted as 'other'.
//   Buckets     : 10-min buckets laid from the end of settle; the final bucket may be shorter. Each bucket is
//                 valued at the median of its per-sample values (a per-kind process count, a per-kind memory
//                 sum or the total memory sum). The reference bucket is the last settle bucket: the 10 min
//                 before settle end, or all of settle when settle is shorter. Every bucket used must hold a
//                 sample.
//   Identity    : a process identity is pid + start time.
//   Supervisor  : a 'sidecar-supervisor' wrapper counts with, and is allowed alongside, the supervised
//                 runtime it wraps ('llama-server', 'fm-serve'). Wherever a count bound applies, a bucket may
//                 hold as many wrappers as the larger of the wrapper bound and the supervised runtimes present
//                 in that bucket within their own bound.
//   Memory bound: max(floor MiB, fraction x the reference-bucket value) of the same series.
//   Theil-Sen   : the median of the pairwise slopes between bucket medians, each placed at the median time
//                 of its samples.
//   Job events  : the audit-count keys that equal, or start with '<name>:', a name in jobEvents. Audit
//                 buckets are the audit-counts file's own 10-min buckets; one belongs to a window when its
//                 midpoint falls inside it. sidecar.spawn is counted the same way.
//   Inputs      : the audit counts must use 10-min buckets and start within 60 s of the stream start.
//   Main        : a sample where the main process is not alive is FAIL, not INCOMPLETE, whatever else holds.
//   Outcome     : INCOMPLETE when a validity clause fails; otherwise FAIL when any check fails; PASS only
//                 when every check below was evaluated and passed.
//
// IDLE-GROWTH-1 (one hosted idle leg, macOS or Windows, at most 5.5 h)
//   Settle      : the first 20 min. The window runs from settle end to the last sample.
//   P1          : for every kind, no window bucket median is above that kind's reference-bucket count.
//   P2          : distinct identities per kind across the window are at most the reference count + 2, and
//                 audit sidecar.spawn events in the window are at most 2.
//   M1          : the Theil-Sen slope of the window bucket medians of total memory, projected from settle end
//                 to 8 h after launch (x 460 min), is at most max(64 MiB, 10%) of the reference total; per
//                 kind at most max(32 MiB, 15%) of that kind's reference sum.
//   M2          : the last window bucket minus the first window bucket stays within the M1 bounds, total and
//                 per kind.
//   C1          : mean one-core CPU% (100 x the summed per-identity cpu-seconds delta / wall seconds) over
//                 the last 60 min is at most the first 60 min after settle + 0.5 points.
//   J1          : job events in the last six audit buckets are at most the first six after settle + 3, and no
//                 window audit bucket holds more than 20.
//   Validity    : at least 300 min measured after settle, at least 95% of the planned samples complete
//                 (planned = one per 30 s from the first to the last sample), and main alive at every sample.
//
// MEETING-GROWTH-1 (the 1 h meeting of the meeting-history leg)
//   Capture     : starts at the given capture start and ends at Stop (both given to growth.mjs; Stop
//                 defaults to 60 min after capture start). Settle is the first 5 min of capture; the window is
//                 capture minutes 5 to Stop. After Stop the post-meeting window runs to the last sample.
//   P0          : ASR ('parakeet-utility', 'whisper-utility'), 'speaker-utility', 'llama-server' and one
//                 'sidecar-supervisor' wrapper per supervised runtime may appear before minute 5. When the
//                 stream holds samples in the 10 min before capture start, every other kind's reference count
//                 is at most its pre-capture count.
//   P1, P2      : as IDLE-GROWTH-1, over the capture window.
//   POST        : every post-meeting bucket's per-kind count is at most the reference (capture) count, with
//                 +1 'llama-server' and +1 'sidecar-supervisor' allowed for the summary.
//   M1          : Theil-Sen slope over the capture window buckets x 55 min: renderer at most
//                 max(96 MiB, 25%), because the live transcript lives in renderer state until the m5 journal;
//                 total at most max(160 MiB, 20%); every other kind, 'sidecar-supervisor' included, at most
//                 max(32 MiB, 15%).
//   POST-M      : the last post-meeting bucket's total is at most the reference (minute-5) total plus the
//                 M1 total bound.
//   J1          : no capture audit bucket holds more than 20 job events.
//   Validity    : at least 55 min of capture sampled, at least one sample after Stop, at least 95% of the
//                 planned samples complete, and main alive at every sample.
//
// Residual (both rules): linear extrapolation cannot see a leak that starts after the leg ends.
import { createHash } from 'node:crypto'

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

// Kept as JSON-compatible data: its canonical serialization is the registered, pinned artefact.
export const RULES = deepFreeze({
  "IDLE_GROWTH_1": {
    "id": "IDLE-GROWTH-1",
    "samplingSeconds": 30,
    "settleMinutes": 20,
    "bucketMinutes": 10,
    "bucketValue": "median of per-sample values",
    "memoryMetric": { "darwin": "physFootprintBytes", "win32": "privateBytes" },
    "kinds": [
      "main", "renderer", "gpu", "parakeet-utility", "whisper-utility", "speaker-utility", "llama-server",
      "fm-serve", "sidecar-supervisor", "crashpad", "utility", "other"
    ],
    "supervisorKind": "sidecar-supervisor",
    "supervisedRuntimeKinds": ["llama-server", "fm-serve"],
    "p2": { "extraIdentitiesPerKind": 2, "maxSidecarSpawns": 2 },
    "m1": {
      "projectToMinutesAfterLaunch": 480,
      "total": { "floorMiB": 64, "fraction": 0.1 },
      "perKind": { "floorMiB": 32, "fraction": 0.15 }
    },
    "m2": { "bounds": "m1" },
    "c1": { "windowMinutes": 60, "maxRisePoints": 0.5 },
    "j1": { "windowBuckets": 6, "maxRiseEvents": 3, "maxPerBucket": 20 },
    "jobEvents": [
      "brain.backfill.start", "brain.consolidation", "brain.ingest", "brain.intelligencePass.start",
      "brain.intelligence_index", "mcp.push.queued", "mcp.push.retried", "scheduler.job"
    ],
    "audit": { "bucketMinutes": 10, "alignSeconds": 60 },
    "validity": { "minMinutesAfterSettle": 300, "minSampleFraction": 0.95, "mainAliveEverySample": true },
    "residual": "linear extrapolation cannot see a leak that starts after the leg ends"
  },
  "MEETING_GROWTH_1": {
    "id": "MEETING-GROWTH-1",
    "samplingSeconds": 30,
    "settleMinutes": 5,
    "captureMinutes": 60,
    "bucketMinutes": 10,
    "bucketValue": "median of per-sample values",
    "memoryMetric": { "darwin": "physFootprintBytes", "win32": "privateBytes" },
    "kinds": [
      "main", "renderer", "gpu", "parakeet-utility", "whisper-utility", "speaker-utility", "llama-server",
      "fm-serve", "sidecar-supervisor", "crashpad", "utility", "other"
    ],
    "supervisorKind": "sidecar-supervisor",
    "supervisedRuntimeKinds": ["llama-server", "fm-serve"],
    "p0": {
      "preCaptureMinutes": 10,
      "mayAppearBeforeSettleEnd": ["parakeet-utility", "whisper-utility", "speaker-utility", "llama-server"]
    },
    "p2": { "extraIdentitiesPerKind": 2, "maxSidecarSpawns": 2 },
    "postMeeting": { "extraCounts": { "llama-server": 1, "sidecar-supervisor": 1 } },
    "m1": {
      "total": { "floorMiB": 160, "fraction": 0.2 },
      "perKind": { "floorMiB": 32, "fraction": 0.15 },
      "kindOverrides": { "renderer": { "floorMiB": 96, "fraction": 0.25 } }
    },
    "j1": { "maxPerBucket": 20 },
    "jobEvents": [
      "brain.backfill.start", "brain.consolidation", "brain.ingest", "brain.intelligencePass.start",
      "brain.intelligence_index", "mcp.push.queued", "mcp.push.retried", "scheduler.job"
    ],
    "audit": { "bucketMinutes": 10, "alignSeconds": 60 },
    "validity": { "minCaptureMinutes": 55, "minSampleFraction": 0.95, "mainAliveEverySample": true },
    "residual": "linear extrapolation cannot see a leak that starts after the leg ends"
  }
})

/** Rule ids as growth.mjs --rule accepts them. */
export const RULE_IDS = Object.freeze(Object.fromEntries(Object.values(RULES).map((rule) => [rule.id, rule])))

/** JSON with object keys sorted at every depth: the byte form the pinned hash covers. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function rulesSha256() {
  return createHash('sha256').update(canonicalJson(RULES), 'utf8').digest('hex')
}
