import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function read(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8')
}

function job(workflow: string, jobName: string): string {
  const lines = workflow.split('\n')
  const start = lines.findIndex((line) => line === `  ${jobName}:`)
  if (start === -1) throw new Error(`Missing workflow job: ${jobName}`)

  const end = lines.findIndex((line, index) => index > start && /^  [a-z0-9-]+:$/.test(line))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

function expectOrdered(source: string, needles: string[]): void {
  let previous = -1
  for (const needle of needles) {
    const index = source.indexOf(needle)
    expect(index, `Expected to find ${JSON.stringify(needle)}`).toBeGreaterThan(previous)
    previous = index
  }
}

function expectPinnedSetupNode(workflow: string): void {
  const setupNodeUses = workflow.match(/uses: actions\/setup-node@v4/g) ?? []
  const versions = [...workflow.matchAll(/node-version:\s*['"]?([^'"\s]+)/g)].map(
    (match) => match[1]
  )

  expect(setupNodeUses.length).toBeGreaterThan(0)
  expect(versions).toHaveLength(setupNodeUses.length)
  expect(new Set(versions)).toEqual(new Set(['22.22.3']))
}

describe('CI runtime and packaged local AI gates', () => {
  const packageJson = JSON.parse(read('package.json')) as {
    engines?: { node?: string }
    engineStrict?: boolean
  }
  const buildWorkflow = read('.github/workflows/build.yml')
  const releaseWorkflow = read('.github/workflows/release.yml')

  it('pins supported Node versions without enabling engine-strict', () => {
    expect(packageJson.engines?.node).toBe('>=22.12.0')
    expect(packageJson.engineStrict).toBeUndefined()
    expect(read('.node-version')).toBe('22.22.3\n')
    expect(read('.nvmrc')).toBe('22.22.3\n')

    const npmrcPath = resolve(repoRoot, '.npmrc')
    if (existsSync(npmrcPath)) {
      expect(readFileSync(npmrcPath, 'utf8')).not.toMatch(/^\s*engine-strict\s*=\s*true\s*$/im)
    }
  })

  it('pins every GitHub Actions Node setup to the supported host version', () => {
    expectPinnedSetupNode(buildWorkflow)
    expectPinnedSetupNode(releaseWorkflow)
  })

  it.each([
    {
      jobName: 'build-macos',
      platform: 'darwin-arm64',
      packageCommand: 'npm run dist -- --arm64'
    },
    {
      jobName: 'build-windows',
      platform: 'win32-x64',
      packageCommand: 'npm run dist:win -- --x64'
    }
  ])(
    'provisions and checks the selected evaluation payload before $jobName packaging',
    ({ jobName, platform, packageCommand }) => {
      const nativeJob = job(buildWorkflow, jobName)

      expectOrdered(nativeJob, [
        'path: resources/local-ai/cache',
        'npm run fetch:local-ai',
        `npm run stage:local-ai -- --platform ${platform}`,
        `npm run check:local-ai -- --platform ${platform}`,
        packageCommand
      ])
      expect(nativeJob).toContain("METIS_ALLOW_EVALUATION_PAYLOAD: '1'")
      expect(nativeJob).not.toContain('--require-release')
    }
  )

  it('keeps Windows AppX packaging explicitly x64', () => {
    expect(job(buildWorkflow, 'build-windows')).toContain('npm run dist:win:appx -- --x64')
  })

  it.each([
    {
      jobName: 'release-macos',
      platform: 'darwin-arm64',
      packageCommand: 'npm run release -- --arm64'
    },
    {
      jobName: 'release-windows',
      platform: 'win32-x64',
      packageCommand: 'npm run release:win -- --x64'
    }
  ])(
    'requires a release-approved payload before $jobName packaging',
    ({ jobName, platform, packageCommand }) => {
      const nativeJob = job(releaseWorkflow, jobName)

      expectOrdered(nativeJob, [
        'path: resources/local-ai/cache',
        'npm run fetch:local-ai',
        `npm run stage:local-ai -- --platform ${platform}`,
        `npm run check:local-ai -- --platform ${platform} --require-release`,
        packageCommand
      ])
    }
  )

  it('never opts tagged release jobs into evaluation payloads', () => {
    expect(releaseWorkflow).not.toContain('METIS_ALLOW_EVALUATION_PAYLOAD')
    expect(releaseWorkflow).not.toContain('--evaluation')
  })
})
