/**
 * Why each skip exists, keyed by a substring of `<file> :: <test title>`.
 *
 * Deliberately prose, not a boolean: the point is that a human wrote down why this path is untested on
 * this platform, so the next person can judge whether it still holds rather than inheriting a silent gap.
 */
export const REASONS = [
  {
    match: 'dustcli.test.ts',
    why: 'Drives the REAL macOS login keychain through `security add-generic-password`. Faking it would test the fake — the whole point is that Metis reads the session `dust login` actually wrote. The region-mapping and partial-session LOGIC is covered cross-platform in dustcli.logic.test.ts.'
  },
  {
    match: 'mac-helper.test.ts',
    why: 'Pipes an image through the real compiled Swift helper. The binary only exists and only runs on macOS.'
  },
  {
    match: 'apple-speech.test.ts',
    why: 'Spawns the real macOS speech subcommand end to end (spawn -> temp wav -> cleanup). No Windows equivalent exists.'
  },
  {
    match: 'check-ffmpeg-sidecar.test.ts',
    why: 'Reads the LGPL/GPL banner out of a real mac ffmpeg build. The licence check is the assertion, so a stubbed banner would assert nothing.'
  },
  {
    match: 'local-runtime.test.ts',
    why: 'Spawns a real mac llama-server against real weights. Its spawn-ARGUMENT contract is covered cross-platform by buildSpawnArgs tests in the same file, which is the part that regressed as `-c undefined`.'
  },
  {
    match: 'fetch-llama-server.test.ts',
    why: 'Exercises Windows zip/bsdtar extraction of the llama-server release asset. On linux/darwin the platform-specific zip path is skipped; cross-platform unpack logic is covered by the same file’s non-skipped cases where tar is available.'
  },
  {
    match: 'cli-win.test.ts',
    why: 'Drives cmd.exe argument quoting on Windows only. Empty-arg delivery through cmd.exe has no equivalent on posix shells.'
  },
  {
    match: 'ffmpeg-decoder.test.ts',
    why: "Needs the packaged ffmpeg sidecar binary for this OS. CI linux images without the sidecar skip the live decode; contract tests cover window sizing without spawning ffmpeg. The cancel test's SIGTERM-immune stand-in is a POSIX shell script; Windows has no signals to ignore (kill is TerminateProcess), so it runs on linux and darwin only."
  },
  {
    match: 'win-security.test.ts',
    why: 'Probes Windows ACL owner SIDs and admin-managed policy files. No-op / skipped on non-Windows hosts by design.'
  },
  {
    match: 'dataless.test.ts',
    why: 'Runs the real Windows PowerShell attribute probe against an NTFS file carrying FILE_ATTRIBUTE_OFFLINE. The binary and the attribute exist only on Windows; the shared wire protocol, decoding and failure policy run on every platform through a stand-in probe.'
  },
  {
    match: 'gateway.test.ts',
    why: 'Pins libuv pool threads with real FIFOs, the kernel-blocking stand-in for a cloud-only read. Windows has no FIFOs; the admission, deadline, sharing and dataless rules run on every platform through an in-memory fs whose calls can be held open.'
  }
]

/** Skips accepted on this platform. Each accepted skip is a platform-bound test with a REASON above.
 *  Lower it when a skip is retired; never raise it for an undeclared skip. */
export const BASELINE = { win32: 16, darwin: 2, linux: 19 }

/**
 * Converts a Vitest result file path to the report id prefix used by the skip gate.
 *
 * @param {unknown} name
 * @returns {string}
 */
export function relFileFromVitestName(name) {
  return String(name ?? '').split(/[\\/]/).slice(-2).join('/')
}

/**
 * Extracts skipped and pending assertion ids from a Vitest JSON report.
 *
 * @param {unknown} report
 * @returns {Array<{ id: string, file: string }>}
 */
export function extractSkippedTests(report) {
  const skipped = []
  if (!report || typeof report !== 'object' || !Array.isArray(report.testResults)) return skipped

  for (const file of report.testResults) {
    if (!file || typeof file !== 'object' || !Array.isArray(file.assertionResults)) continue
    for (const t of file.assertionResults) {
      if (t.status === 'pending' || t.status === 'skipped') {
        const rel = relFileFromVitestName(file.name)
        skipped.push({ id: `${rel} :: ${t.title}`, file: rel })
      }
    }
  }
  return skipped
}

/**
 * Returns the declared skip reason for text containing a known skip-reason match.
 *
 * @param {string} text
 * @returns {string | null}
 */
export function reasonFor(text) {
  return REASONS.find((reason) => String(text).includes(reason.match))?.why ?? null
}
