import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HISTORICAL_197 } from '../qa/historical-197-inputs.mjs'

const read = () =>
  readFileSync(join(__dirname, '../../.github/workflows/historical-197-identity.yml'), 'utf8').replace(/\r\n/g, '\n')

function requireIdentityWorkflow(source: string): void {
  expect(source).toContain("run-name: ${{ github.event_name == 'pull_request' && 'Historical 1.9.7 input identity (registration)' || 'Historical 1.9.7 input identity' }}")
  expect(source).toContain("if: github.event_name == 'workflow_dispatch' && github.repository == 'mysticalsin/AskToto-Mantu' && github.ref == 'refs/heads/main'")
  expect(source).toContain('permissions:\n  contents: read\n  actions: read\n')
  expect(source).toContain('    runs-on: ubuntu-latest\n')
  expect(source).toContain('    timeout-minutes: 20\n')
  expect(source).toContain('          persist-credentials: false\n')
  expect(source).toContain('          node-version: 22.22.3\n')
  expect(source).toContain('test "$(git rev-parse HEAD)" = "$GITHUB_SHA" || { echo "Harness mismatch before retrieval"; exit 1; }')
  expect(source).toContain('test "$(git rev-parse HEAD)" = "$GITHUB_SHA" || { echo "Harness mismatch before verification"; exit 1; }')
  expect(source).toContain('repos/mysticalsin/AskToto-Mantu/actions/runs/38795048288')
  expect(source).toContain('repos/mysticalsin/AskToto-Mantu/releases/414278048')
  expect(source).toContain('harnessCommit: $harness')
  expect(source).toContain('--arg harness "$GITHUB_SHA"')
  expect(source).toContain('head_repository: (.head_repository | repo)')
  for (const asset of HISTORICAL_197.assets) {
    expect(source).toContain(`${asset.id}\t${asset.name}\n`)
  }
  expect(source).toContain('-H "Accept: application/octet-stream"')
  expect(source).toContain('"repos/mysticalsin/AskToto-Mantu/releases/assets/$asset_id"')
  expect(source).toContain('node scripts/qa/historical-197-inputs.mjs --metadata "$OWNED_ROOT/context.json" --assets "$OWNED_ROOT/assets" --harness-commit "$GITHUB_SHA" > "$OWNED_ROOT/receipt.json"')
  expect(source).toContain('.scope == "IDENTITY_ONLY" and .outcome == "VERIFIED" and .verification == "local-bytes"')
  expect(source).toContain('.harness_commit == $harness and .artifact_source == "98461f85dcca49a2ded3f1489daed10d194f5229"')
  expect(source).toContain('.candidate_run == 38795048288 and .candidate_attempt == 1 and .release_id == 414278048')
  expect(source).toContain('          path: ${{ steps.owned.outputs.root }}/receipt.json\n')
  expect(source).toContain('          if-no-files-found: error\n          retention-days: 1\n          overwrite: false\n')
  expect(source).toContain('      - name: Remove only the owned input directory\n        if: always()\n')
  expect(source).toContain('"$RUNNER_TEMP"/metis-historical-197-*) rm -rf -- "$OWNED_ROOT" ;;')
  expect(source.match(/^ {10}path:/gm)).toHaveLength(1)
  expect(source.match(/GH_TOKEN: \$\{\{ github.token \}\}/g)).toHaveLength(1)
  expect(source).not.toMatch(/continue-on-error|contents: write|actions: write|secrets\.|self-hosted|npm |npx |gh run download|gh workflow run|gh release (create|edit|upload)|git push|codesign|hdiutil|\.exe["']?\s+\/S|METIS_QA_|latest.*\.yml/)
  expect(source).not.toMatch(/^\s*(push|schedule|pull_request_target):/m)
  for (const action of [
    'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
    'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
    'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02'
  ]) expect(source).toContain(action)
}

describe('historical 1.9.7 identity input consumer', () => {
  it('gates the actual five-file verifier from a separately observed main harness and retains identity only', () => {
    requireIdentityWorkflow(read())
  })

  it.each([
    ['untrusted ref', "github.ref == 'refs/heads/main'", "github.ref != 'refs/heads/main'"],
    ['foreign initial checkout', 'test "$(git rev-parse HEAD)" = "$GITHUB_SHA" || { echo "Harness mismatch before retrieval"; exit 1; }', 'true'],
    ['foreign verification checkout', 'test "$(git rev-parse HEAD)" = "$GITHUB_SHA" || { echo "Harness mismatch before verification"; exit 1; }', 'true'],
    ['metadata-only gate', '.verification == "local-bytes"', '.verification == "metadata-only"'],
    ['artifact source substituted for harness', '--harness-commit "$GITHUB_SHA"', '--harness-commit "98461f85dcca49a2ded3f1489daed10d194f5229"'],
    ['missing published asset', '645180903\tMetis-1.9.7.zip\n', ''],
    ['private or product bytes retained', 'path: ${{ steps.owned.outputs.root }}/receipt.json', 'path: ${{ steps.owned.outputs.root }}/**'],
    ['write permission', '  contents: read', '  contents: write'],
    ['masked refusal', '      - name: Require full original byte identity', '      - continue-on-error: true\n        name: Require full original byte identity']
  ])('refuses consumer guard mutation: %s', (_name, before, after) => {
    const source = read()
    expect(source.split(before)).toHaveLength(2)
    requireIdentityWorkflow(source)
    expect(() => requireIdentityWorkflow(source.replace(before, after))).toThrow()
  })
})
