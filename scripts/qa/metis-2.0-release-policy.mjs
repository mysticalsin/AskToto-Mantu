// Keep every release publisher on the same fail-closed 2.0 policy.
export const METIS_2_0_ACCEPTANCE_REQUIRED = 'metis-2.0-acceptance-required'

const CANONICAL_VERSION =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/

export function requiresMetis20Acceptance(version) {
  return typeof version === 'string' && CANONICAL_VERSION.test(version) && /^2\.0\./.test(version)
}
