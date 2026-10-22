/**
 * Boot wiring for zero-config Operator reporting (O07, O10). Called once from main/index.ts. Connects the
 * pure enrolment machine, the licence service and the admin kill switch to the real settings store, sign-in
 * state, device identity, network and power events. Kept out of index.ts so that file does not grow.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, powerMonitor } from 'electron'
import { authStatus } from './auth'
import { getEnrollmentIdToken } from './auth-enrollment-token'
import { readEmbeddedOperatorEnrollToken } from './embedded-operator-enroll'
import { getDurableMachineId } from './license'
import { auditLog, mainLog } from './logger'
import {
  configureOperatorEnrollment,
  enrollmentOnResume,
  enrollmentTick,
  operatorReportingStatusFor
} from './operator-enrollment'
import { hashOperatorId } from './operator-hmac-sign'
import {
  applyAutoLicense,
  configureOperatorLicenseService,
  currentAutoLicense,
  demoteAutoLicense,
  dropAutoLicense,
  noteRevokedChecked,
  promoteAutoLicense,
  revokeAutoSeat
} from './operator-license-service'
import { purgeOperatorQueue } from './operator-queue'
import {
  configureOperatorReportingPolicy,
  noteUserScopeReportingPolicy,
  onOperatorReportingPolicyChange,
  operatorReportingAllowed
} from './operator-reporting-policy'
import { adminManagedContent, getSettings } from './store'

const BOOT_ENROLL_DELAY_MS = 5_000

export interface OperatorEnrollmentRuntimeOptions {
  restartRuntime: () => void
  notifyChanged: () => void
}

export function startOperatorEnrollment(opts: OperatorEnrollmentRuntimeOptions): void {
  configureOperatorReportingPolicy({
    readAdmin: adminManagedContent,
    audit: (e, d) => auditLog(e as 'operator.reporting.policy_ignored_user_scope', d)
  })
  // The per-user file is user-writable, so a reporting opt-out there is ignored and only audited. Async read:
  // no synchronous fs on the main process.
  void readFile(join(app.getPath('userData'), 'managed-config.json'), 'utf8')
    .then((raw) => noteUserScopeReportingPolicy(raw))
    .catch(() => undefined)
  configureOperatorLicenseService({ restartRuntime: opts.restartRuntime, notifyChanged: opts.notifyChanged })
  configureOperatorEnrollment({
    getSettings,
    now: Date.now,
    fetch: (input, init) => fetch(input, init),
    deviceId: () => {
      const id = getDurableMachineId()
      return id ? hashOperatorId(id) : null
    },
    idToken: getEnrollmentIdToken,
    signedIn: () => {
      try {
        return authStatus().signedIn
      } catch {
        return false
      }
    },
    embeddedToken: readEmbeddedOperatorEnrollToken,
    currentLicense: currentAutoLicense,
    applyAutoLicense,
    promote: promoteAutoLicense,
    demote: demoteAutoLicense,
    drop: dropAutoLicense,
    revoke: revokeAutoSeat,
    noteRevokedChecked,
    appVersion: () => app.getVersion(),
    os: () => process.platform
  })
  // Kill switch: when machine policy turns reporting off, discard anything queued and stop the runtime; when it
  // is lifted, start again. The first read also purges a queue left from before the policy was applied.
  if (!operatorReportingAllowed()) purgeOperatorQueue(app.getPath('userData'))
  onOperatorReportingPolicyChange((allowed) => {
    if (!allowed) purgeOperatorQueue(app.getPath('userData'))
    opts.restartRuntime()
    opts.notifyChanged()
  })
  const boot = setTimeout(() => void enrollmentTick('boot'), BOOT_ENROLL_DELAY_MS)
  boot.unref()
  try {
    powerMonitor.on('resume', enrollmentOnResume)
    powerMonitor.on('unlock-screen', enrollmentOnResume)
  } catch (e) {
    mainLog.warn('[operator] powerMonitor hook failed:', e)
  }
}

export function operatorReportingSnapshot(): {
  status: ReturnType<typeof operatorReportingStatusFor>
  origin: 'admin' | 'sso' | 'token' | null
  state: 'unenrolled' | 'enrolled' | 'revoked'
} {
  const s = getSettings()
  return { status: operatorReportingStatusFor(s), origin: s.operatorLicenseOrigin, state: s.operatorEnrollState }
}

export { enrollmentOnSignedIn } from './operator-enrollment'
