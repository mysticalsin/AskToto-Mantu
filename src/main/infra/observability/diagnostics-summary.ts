import type { RevealOutcome } from './reveal-trace'

export interface DiagnosticsIdentity {
  version: string
  platform: string
  arch: string
}

export interface DiagnosticsSummary {
  kind: 'metis-diagnostics-summary'
  schema: 1
  generatedAt: string
  app: DiagnosticsIdentity
  window: { from: string | null; to: string | null; records: number }
  boots: { started: number; prevShutdown: Record<'clean' | 'unclean' | 'unknown', number> }
  stalls: { under2s: number; '2to5s': number; '5to30s': number; '30sPlus': number }
  crashes: { fatal: number; nonFatal: number; unclassified: number }
  reveals: Record<RevealOutcome, number>
  events: Record<string, number>
}

export function summarizeAuditTrail(
  _lines: readonly string[],
  _identity: DiagnosticsIdentity,
  _generatedAt: Date
): DiagnosticsSummary {
  // Scaffolding: the real audit-trail aggregation logic lands in the next commit (M2-0215).
  throw new Error('M2-0215: not implemented until the next commit')
}

/** Never rejects: an unreadable or missing trail yields a zero summary, which is still copied. */
export async function copyDiagnosticsSummary(_opts: {
  auditTrailPath: string
  identity: DiagnosticsIdentity
  writeText: (text: string) => void
  now?: () => Date
}): Promise<void> {
  // Scaffolding: the real diagnostics copy logic lands in the next commit (M2-0215).
  throw new Error('M2-0215: not implemented until the next commit')
}
