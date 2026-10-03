/**
 * Builds the content-free report the packaged launch gate writes for one installer (`--report`), kept
 * free of I/O so it can be unit tested. The report is evidence that binds a launch verdict to the exact
 * bytes tested, so it carries only identifiers and outcomes: never a window title, dialog text, log
 * line or any path beyond the installer's file name.
 */

const SHA256 = /^[0-9a-f]{64}$/
// An Authenticode status, "ad-hoc", or a certificate sha1: a short token, never free text.
const SIGNATURE = /^[A-Za-z0-9._:-]{1,64}$/
const PLATFORMS = ['darwin', 'win32']
const VERDICTS = ['PASS', 'FAIL']

/** The final path segment, whichever separator the runner used, so no directory survives. */
function leafName(path) {
  return String(path).split(/[\\/]/).filter(Boolean).pop() ?? ''
}

/**
 * @param {object} input
 * @param {string} input.installer installer path or name; only its file name is kept
 * @param {string} input.artifactSha256 lowercase hex sha256 of the installer
 * @param {string} [input.candidateRun] the qa-candidate run id the bytes came from
 * @param {string} [input.signature] signature state observed for the installer
 * @param {'darwin' | 'win32'} input.platform
 * @param {'PASS' | 'FAIL'} input.verdict
 * @param {boolean} input.productWindowObserved
 * @param {boolean | null} input.errorDialogSeen null when the platform gate cannot inspect dialogs
 * @param {number} input.elapsedMs
 */
export function buildLaunchReport(input) {
  const problems = []
  const installer = leafName(input.installer ?? '')
  if (!installer) problems.push('installer name is empty')
  if (!SHA256.test(input.artifactSha256 ?? '')) problems.push('artifact sha256 is not 64 lowercase hex characters')
  const candidateRun = input.candidateRun === undefined ? null : Number(input.candidateRun)
  if (candidateRun !== null && !(Number.isInteger(candidateRun) && candidateRun > 0)) {
    problems.push('candidate run is not a positive integer')
  }
  const signature = input.signature ?? null
  if (signature !== null && !SIGNATURE.test(signature)) problems.push('signature state is not a short token')
  if (!PLATFORMS.includes(input.platform)) problems.push('platform is not darwin or win32')
  if (!VERDICTS.includes(input.verdict)) problems.push('verdict is not PASS or FAIL')
  if (typeof input.productWindowObserved !== 'boolean') problems.push('productWindowObserved is not a boolean')
  if (input.errorDialogSeen !== null && typeof input.errorDialogSeen !== 'boolean') {
    problems.push('errorDialogSeen is not a boolean or null')
  }
  if (!Number.isInteger(input.elapsedMs) || input.elapsedMs < 0) problems.push('elapsedMs is not a non-negative integer')
  if (problems.length) throw new Error(`invalid launch report: ${problems.join('; ')}`)

  return {
    installer,
    artifact_sha256: input.artifactSha256,
    candidate_run: candidateRun,
    signature,
    platform: input.platform,
    verdict: input.verdict,
    product_window_observed: input.productWindowObserved,
    error_dialog_seen: input.errorDialogSeen,
    elapsed_ms: input.elapsedMs
  }
}
