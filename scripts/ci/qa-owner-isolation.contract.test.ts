import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(join(__dirname, '../../.github/workflows/qa-candidate.yml'), 'utf8').replace(/\r\n/g, '\n')
const ownerJobs = ['st1-mac-fifo', 'st1-mac-control'] as const
const jobs = new Map(
  workflow
    .slice(workflow.indexOf('\njobs:\n') + '\njobs:\n'.length)
    .split(/^(?= {2}[a-z0-9-]+:\n)/m)
    .flatMap((block): [string, string][] => {
      const name = /^ {2}([a-z0-9-]+):\n/.exec(block)?.[1]
      return name ? [[name, block]] : []
    })
)

function steps(name: string): string[] {
  const block = jobs.get(name)
  expect(block, `missing owner job ${name}`).toBeDefined()
  return block!.split(/^(?= {6}- )/m).slice(1)
}

function stepWith(all: string[], property: string, value: string): string {
  const matches = all.filter((step) =>
    step.split('\n').some((line) => line === `      - ${property}: ${value}` || line === `        ${property}: ${value}`)
  )
  expect(matches, `exactly one step with ${property}: ${value}`).toHaveLength(1)
  return matches[0]
}

function strictProfile(step: string): void {
  // Bind the assertion to this step's env mapping, not another step or a shell comment.
  const env = /^ {8}env:\n((?: {10}.+(?:\n|$))+)/m.exec(step)?.[1] ?? ''
  expect(env).toMatch(/^ {10}OWNER_SANDBOX_PROFILE: owner-runner\.sb$/m)
}

describe('owner QA isolation workflow admission [M2-0538]', () => {
  it('covers exactly the two jobs assigned to the owner Mac', () => {
    expect(
      [...jobs]
        .filter(([, block]) => /^ {4}runs-on: \[self-hosted, macOS, ARM64, metis-owner-mac\]$/m.test(block))
        .map(([name]) => name)
    ).toEqual([...ownerJobs])
  })

  describe.each(ownerJobs)('%s', (name) => {
    it('selects the strict profile on the probe before any Node setup or artifact download', () => {
      const all = steps(name)
      const probes = all.filter((step) => /^ {8}run: bash scripts\/hermetic\/prove-owner-sandbox\.sh$/m.test(step))
      expect(probes).toHaveLength(1)
      const probe = probes[0]
      expect(all.indexOf(probe)).toBe(1)
      strictProfile(probe)
      for (const step of all.filter((entry) => /uses: actions\/(?:setup-node|download-artifact)@/.test(entry))) {
        expect(all.indexOf(probe)).toBeLessThan(all.indexOf(step))
      }
    })

    it.each(['Verify every byte against the provenance', 'Verify every byte against the provenance (retry)'])(
      'isolates the individual %s step',
      (stepName) => {
        const step = stepWith(steps(name), 'name', stepName)
        strictProfile(step)
        expect(step).toMatch(
          /^ {8}run: bash scripts\/hermetic\/run-under-owner-sandbox\.sh node scripts\/qa\/provenance\.mjs verify provenance\/provenance\.json assets mac-qa-identity$/m
        )
      }
    )

    it('isolates the packaged measurement rather than only its provenance check', () => {
      const measurements = steps(name).filter((step) =>
        /^ {10}bash scripts\/hermetic\/run-under-owner-sandbox\.sh node scripts\/qa\/st-1\.mjs \\$/m.test(step)
      )
      expect(measurements).toHaveLength(1)
      strictProfile(measurements[0])
    })

    it('requires a successful read-only precheck before candidate access and a fail-closed postcheck even after measurement failure', () => {
      const all = steps(name)
      const before = stepWith(all, 'id', 'qa_keychain_before')
      const after = stepWith(all, 'id', 'qa_keychain_after')
      const probe = all.findIndex((step) => /^ {8}run: bash scripts\/hermetic\/prove-owner-sandbox\.sh$/m.test(step))
      const firstDownload = all.findIndex((step) => /uses: actions\/download-artifact@/.test(step))
      const measurement = all.findIndex((step) =>
        /^ {10}bash scripts\/hermetic\/run-under-owner-sandbox\.sh node scripts\/qa\/st-1\.mjs \\$/m.test(step)
      )
      expect(probe).toBeGreaterThanOrEqual(0)
      expect(firstDownload).toBeGreaterThanOrEqual(0)
      expect(measurement).toBeGreaterThanOrEqual(0)
      expect(all.indexOf(before)).toBeGreaterThan(probe)
      expect(all.indexOf(before)).toBeLessThan(firstDownload)
      expect(all.indexOf(after)).toBeGreaterThan(measurement)
      expect(before).not.toMatch(/^ {8}(?:if|continue-on-error):/m)
      expect(after).toMatch(/^ {8}if: always\(\) && steps\.qa_keychain_before\.outcome == 'success'$/m)
      expect(after).not.toMatch(/^ {8}continue-on-error:/m)
      for (const check of [before, after]) {
        expect(check).toMatch(/^ {8}run: \|$/m)
        expect(check).not.toMatch(/\|\|\s*true|set \+e|delete-generic-password/)
      }
    })

    it('confines cleanup to isolated temporary state without deleting any home or keychain data', () => {
      const cleanup = stepWith(steps(name), 'name', 'Remove ST-1 temporary state')
      expect(cleanup).not.toMatch(/\$(?:HOME\b|\{HOME\})|delete-generic-password/)
      expect(jobs.get(name)).not.toMatch(/security\s+(?:delete|add|set|unlock|create)[a-z-]*\b/)
      strictProfile(cleanup)
      expect(cleanup).toMatch(/^ {8}if: always\(\)$/m)
      expect(cleanup).toContain('scripts/hermetic/run-under-owner-sandbox.sh')
    })
  })
})
