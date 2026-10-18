#!/usr/bin/env node
// Validate the original report before retaining it. No app, installer, download or profile write.
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { HISTORICAL_197 } from './historical-197-inputs.mjs'
import { BASELINE, REQUIRED_CHECKS, assessHistoricalUpgradeReport } from './historical-197-windows-upgrade.mjs'

const MAX_REPORT_BYTES = 65_536
const REFUSED = Object.freeze({ closed: false, accepted: false })
const COMMIT = /^[0-9a-f]{40}$/
const HASH = /^[0-9a-f]{64}$/
const LIMITATIONS = ['Baseline source attribution is not signed provenance.', 'No rollback, recovery, authenticated-enterprise, ACL, foreign-account, notes, recap-generation or full-release security qualification.']
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
const positivePid = (pid) => Number.isSafeInteger(pid) && pid > 1
const samePath = (left, right) => process.platform === 'win32' ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right)
const sameFile = (left, right) => ['dev', 'ino', 'mode', 'size', 'mtimeMs', 'ctimeMs', 'birthtimeMs'].every((key) => left[key] === right[key])

/** Closed content permits retention; only the actual upgrade assessor can establish acceptance. */
export function assessClosedHistoricalWindowsReport(report, harnessCommit) {
  try {
    if (!COMMIT.test(harnessCommit ?? '') || !exact(report, ['schema', 'scope', 'platform', 'harnessCommit', 'appSource', 'baseline', 'candidate', 'processes', 'installers', 'nativeSnapshots', 'checks', 'error', 'accepted', 'limitations']) ||
      report.schema !== 1 || report.scope !== 'HEALTHY_NATIVE_196_TO_PUBLISHED_197_ONLY' || report.platform !== 'win32' ||
      report.harnessCommit !== harnessCommit || report.appSource !== HISTORICAL_197.artifactSource || typeof report.accepted !== 'boolean' ||
      !exact(report.baseline, Object.keys(BASELINE)) || JSON.stringify(report.baseline) !== JSON.stringify(BASELINE) ||
      !exact(report.candidate, Object.keys(HISTORICAL_197.assets[2])) || JSON.stringify(report.candidate) !== JSON.stringify(HISTORICAL_197.assets[2]) ||
      !Array.isArray(report.limitations) || JSON.stringify(report.limitations) !== JSON.stringify(LIMITATIONS) ||
      !(report.error === null || REQUIRED_CHECKS.includes(report.error)) ||
      !Array.isArray(report.processes) || report.processes.length > 3 || !report.processes.every(positivePid) ||
      !Array.isArray(report.installers) || report.installers.length > 2 || !report.installers.every((item, index) =>
        exact(item, ['version', 'pid', 'exitCode', 'censusConfirmed', 'closed']) && item.version === ['1.9.6', '1.9.7'][index] &&
        positivePid(item.pid) && item.exitCode === 0 && item.censusConfirmed === true && item.closed === true) ||
      !Array.isArray(report.nativeSnapshots) || report.nativeSnapshots.length > 3 || !report.nativeSnapshots.every((item) =>
        exact(item, ['native', 'settingsSha256', 'providerSha256', 'meetingSha256', 'fileKeyPresent']) && item.native === true &&
        typeof item.fileKeyPresent === 'boolean' && [item.settingsSha256, item.providerSha256, item.meetingSha256].every((hash) => typeof hash === 'string' && HASH.test(hash))) ||
      !Array.isArray(report.checks) || report.checks.length !== REQUIRED_CHECKS.length || !report.checks.every((row) =>
        exact(row, ['id', 'status']) && REQUIRED_CHECKS.includes(row.id) && ['PASS', 'FAIL', 'NOT_RUN'].includes(row.status)) ||
      !REQUIRED_CHECKS.every((id) => report.checks.filter((row) => row.id === id).length === 1)) return REFUSED
    if (!report.accepted) {
      const errorIndex = REQUIRED_CHECKS.indexOf(report.error)
      const cleanupIndex = REQUIRED_CHECKS.indexOf('cleanup')
      if (errorIndex < 0 || report.checks[errorIndex].status !== 'FAIL' ||
        report.checks.some((row, index) => index < errorIndex ? row.status !== 'PASS' :
          index === errorIndex ? row.status !== 'FAIL' : index < cleanupIndex ? row.status !== 'NOT_RUN' :
            !['PASS', 'FAIL'].includes(row.status))) return REFUSED
    }
    const accepted = assessHistoricalUpgradeReport(report)
    if (report.accepted !== accepted) return REFUSED
    return { closed: true, accepted }
  } catch {
    return REFUSED
  }
}

/** One real descriptor, bounded bytes, stable regular-file identity and one awaited close. */
export async function readClosedHistoricalWindowsReport(reportPath, harnessCommit) {
  let handle
  let result = REFUSED
  try {
    if (typeof reportPath !== 'string' || !isAbsolute(reportPath) || basename(reportPath) !== 'report.json') return REFUSED
    const parent = dirname(reportPath)
    const parentStat = await fs.lstat(parent)
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || !samePath(await fs.realpath(parent), parent)) return REFUSED
    const before = await fs.lstat(reportPath)
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > MAX_REPORT_BYTES) return REFUSED
    handle = await fs.open(reportPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const opened = await handle.stat()
    if (!opened.isFile() || !sameFile(before, opened)) return REFUSED
    const buffer = Buffer.alloc(MAX_REPORT_BYTES + 1)
    let count = 0
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, null)
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length - count) return REFUSED
      if (bytesRead === 0) break
      count += bytesRead
    }
    const after = await handle.stat()
    const current = await fs.lstat(reportPath)
    if (count !== opened.size || count > MAX_REPORT_BYTES || !sameFile(opened, after) ||
      !current.isFile() || current.isSymbolicLink() || !sameFile(after, current) || !samePath(await fs.realpath(parent), parent)) return REFUSED
    result = assessClosedHistoricalWindowsReport(JSON.parse(buffer.subarray(0, count).toString('utf8')), harnessCommit)
  } catch {
    result = REFUSED
  } finally {
    if (handle) {
      try { await handle.close() } catch { result = REFUSED }
    }
  }
  return result
}

async function main(argv) {
  if (argv.length !== 4 || argv[0] !== '--report' || argv[2] !== '--harness-commit') throw new Error('report-refused')
  const result = await readClosedHistoricalWindowsReport(argv[1], argv[3])
  process.stdout.write(`historical-windows-report:${!result.closed ? 'REFUSED' : result.accepted ? 'PASS' : 'FAIL'}\n`)
  process.exitCode = !result.closed ? 2 : result.accepted ? 0 : 3
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => { process.stdout.write('historical-windows-report:REFUSED\n'); process.exitCode = 2 })
}
