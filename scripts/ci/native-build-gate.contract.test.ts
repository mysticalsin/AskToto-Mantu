import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n')
const workflow = read('.github', 'workflows', 'build.yml')
const project = read('native-app', 'project.yml')

function nativeJob(): string {
  const lines = workflow.split('\n')
  expect(lines.filter((line) => line === '  native:'), 'one native build job').toHaveLength(1)
  const start = lines.indexOf('  native:')
  const end = lines.findIndex((line, index) => index > start && /^ {2}[A-Za-z0-9_-]+:/.test(line))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

function appBuildStep(job: string): string {
  const lines = job.split('\n')
  const header = '      - name: Build the native App (macOS)'
  expect(lines.filter((line) => line === header), 'one native App build step').toHaveLength(1)
  const start = lines.indexOf(header)
  const end = lines.findIndex((line, index) => index > start && /^ {6}- /.test(line))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

describe('native App build failure gate', () => {
  it('fails the workflow when the native App build fails', () => {
    const job = nativeJob()
    const step = appBuildStep(job)
    const jobPolicy = job.match(/^ {4}continue-on-error:\s*([^\n]*)$/m)?.[1]?.trim()
    const stepPolicy = step.match(/^ {8}continue-on-error:\s*([^\n]*)$/m)?.[1]?.trim()

    expect([undefined, 'false'], 'native job must not ignore failures').toContain(jobPolicy)
    expect([undefined, 'false'], 'native App build step must not ignore failures').toContain(stepPolicy)
  })

  it('runs the real unsigned macOS Debug build without masking its exit status', () => {
    const job = nativeJob()
    const step = appBuildStep(job)
    const command = step.match(/^ {8}run: \|\n([\s\S]*)$/m)?.[1]?.replace(/\s*\\\n\s*/g, ' ').trim()

    expect(job).toMatch(/^ {4}runs-on: macos-latest$/m)
    expect(step).toMatch(/^ {8}working-directory: native-app$/m)
    expect(step).not.toMatch(/^ {8}(?:if|shell):/m)
    expect(command).toBe(
      'xcodebuild -project Metis.xcodeproj -scheme Metis -configuration Debug ' +
        "-destination 'generic/platform=macOS' CODE_SIGNING_ALLOWED=NO build"
    )
  })

  it('keeps Swift 6 and complete strict concurrency enabled for the App target', () => {
    expect(project.match(/^ {8}SWIFT_VERSION:.*$/gm)).toEqual(['        SWIFT_VERSION: "6.0"'])
    expect(project.match(/^ {8}SWIFT_STRICT_CONCURRENCY:.*$/gm)).toEqual(['        SWIFT_STRICT_CONCURRENCY: complete'])
  })
})
