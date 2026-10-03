import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHECK_SECRETS, DEPLOY_ARTIFACT, DEPLOY_SECRET } from '../qa/staging-checks/index.mjs'
import { findUnpinnedUses } from './check-workflow-pins.mjs'

const root = join(__dirname, '..', '..')
const read = (name: string) => readFileSync(join(root, '.github', 'workflows', name), 'utf8').replace(/\r\n/g, '\n')
const workflow = read('operator-staging.yml')
const lines = workflow.split('\n')
const DISPATCH_CLAUSE = "github.event_name == 'workflow_dispatch'"

/** The lines of a block that starts at `header` and ends at the next line indented `indent` or less. */
function block(from: string[], header: string, indent: number): string[] {
  const start = from.findIndex((line) => line === header)
  expect(start, `block not found: ${header.trim()}`).toBeGreaterThan(-1)
  const body: string[] = []
  for (const line of from.slice(start + 1)) {
    if (line.trim() !== '' && line.length - line.trimStart().length <= indent) break
    body.push(line)
  }
  return body
}

function jobNames(): string[] {
  return block(lines, 'jobs:', 0)
    .map((line) => line.match(/^ {2}([A-Za-z0-9_-]+):$/)?.[1])
    .filter((name): name is string => Boolean(name))
}

const job = (name: string) => block(lines, `  ${name}:`, 2)

/** A job's `if:` condition, folded scalars joined into one line. */
function condition(name: string): string {
  const body = job(name)
  const index = body.findIndex((line) => /^ {4}if:/.test(line))
  expect(index, `${name} has no if:`).toBeGreaterThan(-1)
  const head = body[index].replace(/^ {4}if:\s*/, '')
  if (!/^[>|][-+]?$/.test(head)) return head
  const folded: string[] = []
  for (const line of body.slice(index + 1)) {
    if (!/^ {6}\S/.test(line)) break
    folded.push(line.trim())
  }
  return folded.join(' ')
}

/** A job's steps: each one the text from its `- ` line to the next. */
function steps(name: string): string[] {
  const result: string[] = []
  for (const line of block(job(name), '    steps:', 4)) {
    if (/^ {6}- /.test(line)) result.push(line)
    else if (result.length) result[result.length - 1] += `\n${line}`
  }
  return result
}

const stepIndex = (all: string[], fragment: string) => {
  const index = all.findIndex((step) => step.includes(fragment))
  expect(index, `step not found: ${fragment}`).toBeGreaterThan(-1)
  return index
}

const secretRefs = (text: string) => [...text.matchAll(/\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/g)].map((match) => match[1])

describe('operator-staging.yml', () => {
  it('self-registers on pull requests and dispatches by hand with a deploy boolean and a check name', () => {
    const on = block(lines, 'on:', 0).filter((line) => /^ {2}\S/.test(line))
    expect(on).toEqual(['  pull_request:', '  workflow_dispatch:'])
    expect(block(lines, '  pull_request:', 2)).toEqual(['    paths:', '      - .github/workflows/operator-staging.yml'])
    const inputs = block(lines, '    inputs:', 4)
    expect(inputs.filter((line) => /^ {6}\S/.test(line)).map((line) => line.trim())).toEqual(['deploy:', 'check:'])
    expect(block(inputs, '      deploy:', 6)).toContain('        type: boolean')
    expect(block(inputs, '      deploy:', 6)).toContain('        default: false')
    expect(block(inputs, '      check:', 6)).toContain('        type: string')
    expect(workflow).toMatch(/^run-name: .*'Operator staging \(registration\)'/m)
  })

  it('runs real jobs only on a workflow_dispatch from main in this repository, behind the registry guard', () => {
    expect(jobNames()).toEqual(['guard', 'deploy', 'check'])
    expect(condition('guard')).toBe(
      "github.event_name == 'workflow_dispatch' && github.repository == 'mysticalsin/AskToto-Mantu' && github.ref == 'refs/heads/main'"
    )
    // A pull_request run therefore skips every job: none can start without the dispatch clause.
    for (const name of jobNames()) expect(condition(name)).toContain(DISPATCH_CLAUSE)
    expect(condition('deploy')).toContain("github.ref == 'refs/heads/main'")
    expect(condition('deploy')).toContain('inputs.deploy')
    expect(job('deploy')).toContain('    needs: guard')
    expect(job('check')).toContain('    needs: [guard, deploy]')
    expect(condition('check')).toContain("needs.guard.result == 'success'")
    expect(condition('check')).toContain("(needs.deploy.result == 'success' || needs.deploy.result == 'skipped')")
    const guard = steps('guard')
    const refuse = guard[stepIndex(guard, 'index.mjs guard')]
    expect(refuse).toContain('CHECK: ${{ inputs.check }}')
    expect(refuse).toContain('node scripts/qa/staging-checks/index.mjs guard --check "$CHECK"')
    expect(job('guard').join('\n')).not.toContain('secrets.')
  })

  it('serialises every run in one concurrency group, reads contents and actions only, and pins every action by full SHA', () => {
    expect(block(lines, 'concurrency:', 0)).toEqual(['  group: operator-staging', '  cancel-in-progress: false'])
    expect(lines.filter((line) => /^\s+concurrency:/.test(line))).toEqual([])
    expect(block(lines, 'permissions:', 0).filter((line) => line.trim())).toEqual(['  contents: read', '  actions: read'])
    expect(lines.filter((line) => /^\s+permissions:/.test(line))).toEqual([])
    expect(findUnpinnedUses(workflow)).toEqual([])
  })

  it('references the staging Cloudflare token in the deploy step only, which is never skipped', () => {
    const deploy = steps('deploy')
    const deployStep = deploy[stepIndex(deploy, 'node operator/scripts/deploy.mjs --env staging --outdir')]
    expect(secretRefs(deployStep)).toEqual([DEPLOY_SECRET])
    expect(deployStep).toContain(`CLOUDFLARE_API_TOKEN: \${{ secrets.${DEPLOY_SECRET} }}`)
    expect(workflow.split(DEPLOY_SECRET).length - 1).toBe(1)
    expect(workflow.split('CLOUDFLARE_API_TOKEN').length - 1).toBe(1)
    // A dispatch without the token reaches this step and fails with the CLI's error; nothing skips it.
    expect(deployStep).not.toMatch(/^\s+if:/m)
    expect(deployStep).not.toContain('continue-on-error')
    expect(job('deploy').join('\n')).not.toMatch(/continue-on-error|secrets\.[A-Z_]+ *!=|secrets\.[A-Z_]+ *==/)
    for (const [index, step] of deploy.entries()) if (index !== deploy.indexOf(deployStep)) expect(secretRefs(step)).toEqual([])
  })

  it('maps exactly the fixed check secrets into the check step and no secret anywhere else', () => {
    const check = steps('check')
    const run = check[stepIndex(check, 'index.mjs run')]
    expect(secretRefs(run)).toEqual([...CHECK_SECRETS])
    for (const name of CHECK_SECRETS) expect(run).toContain(`${name}: \${{ secrets.${name} }}`)
    expect(secretRefs(workflow).sort()).toEqual([DEPLOY_SECRET, ...CHECK_SECRETS].sort())
    expect(job('check').filter((line) => /^ {6}[A-Z_]+:/.test(line)).join('\n')).not.toContain('secrets.')
  })

  it('deploys only in the protected staging environment, after the dry-run plan names only staging', () => {
    expect(job('deploy')).toContain('    environment: staging')
    expect(job('check')).toContain('    environment: staging')
    expect(job('guard')).not.toContain('    environment: staging')
    const deploy = steps('deploy')
    const order = [
      'run: npm ci',
      'node operator/scripts/deploy.mjs --dry-run --env staging',
      'node operator/scripts/deploy.mjs --env staging --outdir "$RUNNER_TEMP/worker-bundle"',
      'index.mjs receipt --bundle-dir "$RUNNER_TEMP/worker-bundle"',
      'index.mjs scan "$OUT"',
      'actions/upload-artifact@'
    ].map((fragment) => stepIndex(deploy, fragment))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    const plan = deploy[stepIndex(deploy, '--dry-run --env staging')]
    // The build.yml assertions, kept in step with that file.
    const buildYml = read('build.yml')
    for (const assertion of [
      "grep -q 'worker:        metis-operator-staging'",
      "grep -q 'd1 database:   metis-operator-staging'",
      "grep -q 'migrate.mjs --remote --env staging'",
      "grep -Eq 'wrangler.js deploy .*--env staging'",
      "grep -q 'metis-operator$'"
    ]) {
      expect(plan).toContain(assertion)
      expect(buildYml).toContain(assertion)
    }
    expect(plan).toContain('plan="$RUNNER_TEMP/staging-plan.txt"')
    const receipt = deploy[stepIndex(deploy, 'index.mjs receipt')]
    expect(receipt).toContain('id: receipt')
    expect(receipt).toContain('--version "$(git rev-parse --short HEAD)"')
    expect(block(job('deploy'), '    outputs:', 4)).toEqual([
      '      version: ${{ steps.receipt.outputs.version }}',
      '      bundle_sha256: ${{ steps.receipt.outputs.bundle_sha256 }}'
    ])
    const upload = deploy[stepIndex(deploy, 'actions/upload-artifact@')]
    expect(upload).toContain(`name: ${DEPLOY_ARTIFACT}`)
    expect(upload).not.toMatch(/^\s+if:/m)
  })

  it('checks the staging URL from a repository variable, binds the deploy run, and fails on a failing check', () => {
    expect(job('check')).toContain('      STAGING_URL: ${{ vars.OPERATOR_STAGING_URL }}')
    expect(workflow).not.toMatch(/https:\/\/[^\s'"]*workers\.dev/)
    const check = steps('check')
    const order = ['run: npm ci', 'index.mjs version', `--name ${DEPLOY_ARTIFACT}`, 'index.mjs run', 'index.mjs scan', 'actions/upload-artifact@', 'exit 1'].map(
      (fragment) => stepIndex(check, fragment)
    )
    expect(order).toEqual([...order].sort((a, b) => a - b))
    const find = check[stepIndex(check, `--name ${DEPLOY_ARTIFACT}`)]
    expect(find).toContain('candidates="$GITHUB_RUN_ID"')
    expect(find).toContain('index.mjs deploy-runs "$RUNNER_TEMP/runs.json" --version "$DEPLOYED_VERSION"')
    const run = check[stepIndex(check, 'index.mjs run')]
    expect(run).toContain('--check "$CHECK" --expected-version "$(git rev-parse --short HEAD)"')
    expect(run).toContain('--deploy-run "$DEPLOY_RUN" --deploy-receipt "$DEPLOY_RECEIPT"')
    expect(run).toContain('id: check')
    const fail = check[stepIndex(check, 'exit 1')]
    expect(fail).toContain("if: always() && (steps.check.outcome != 'success' || steps.scan.outcome != 'success')")
  })
})
