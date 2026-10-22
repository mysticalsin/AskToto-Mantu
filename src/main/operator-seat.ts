/**
 * Operator seat classification for main. The ONE place that decides which Operator transport a caller gets
 * (O08):
 *
 *  - Telemetry transport: heartbeat, ingest, queue drain. Accepts any credential, including the reporting-only
 *    licence from zero-config enrolment. Off only under the admin kill switch.
 *  - Managed transport: entitlement gates, model policy, skills manifest, integrations, speech authority,
 *    funded asks, the Operator command route. Present only for a seat an administrator chose (admin or MDM
 *    licence, legacy secret, env secret) or an auto seat upgraded to a real tier. An auto reporting seat gets
 *    nothing here, so it behaves exactly like today's unconfigured install.
 */
import {
  operatorManagedSeat,
  resolveOperatorBaseUrl,
  resolveOperatorCredential,
  resolveOperatorTelemetryCredential,
  type OperatorTransportSettings
} from '@shared/operator'
import { operatorReportingAllowed } from './operator-reporting-policy'

type Env = Record<string, string | undefined>

export function operatorManaged(settings: OperatorTransportSettings, env: Env = process.env): boolean {
  return operatorReportingAllowed() && operatorManagedSeat(settings, settings.operatorTier, env)
}

/** Credential for a managed feature, or '' for an unconfigured or auto reporting seat. */
export function operatorManagedCredential(settings: OperatorTransportSettings, env: Env = process.env): string {
  return operatorManaged(settings, env) ? resolveOperatorCredential(settings, env) : ''
}

export function operatorManagedTransport(
  settings: OperatorTransportSettings,
  env: Env = process.env
): { url: string; secret: string } | null {
  const url = resolveOperatorBaseUrl(settings, env)
  const secret = operatorManagedCredential(settings, env)
  return url && secret ? { url, secret } : null
}

/** Credential for heartbeat, ingest and drain. '' under the kill switch. */
export function operatorTelemetryCredential(settings: OperatorTransportSettings, env: Env = process.env): string {
  return operatorReportingAllowed() ? resolveOperatorTelemetryCredential(settings, env) : ''
}

export function operatorTelemetryTransport(
  settings: OperatorTransportSettings,
  env: Env = process.env
): { url: string; secret: string } | null {
  const url = resolveOperatorBaseUrl(settings, env)
  const secret = operatorTelemetryCredential(settings, env)
  return url && secret ? { url, secret } : null
}

/** True for a seat that reports with an auto-enrolled licence and has no managed standing. */
export function operatorReportingOnlySeat(settings: OperatorTransportSettings, env: Env = process.env): boolean {
  return !!settings.operatorReportingToken?.trim() && !operatorManaged(settings, env)
}
