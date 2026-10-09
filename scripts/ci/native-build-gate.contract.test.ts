import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n')
const workflow = read('.github', 'workflows', 'build.yml')
const project = read('native-app', 'project.yml')

function nativeJob(): string {
  const lines = workflow.split('\n')
  expect(
    lines.filter((line) => line === '  native:'),
    'one native build job'
  ).toHaveLength(1)
  const start = lines.indexOf('  native:')
  const end = lines.findIndex((line, index) => index > start && /^ {2}[A-Za-z0-9_-]+:/.test(line))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

function appBuildStep(job: string): string {
  const lines = job.split('\n')
  const header = '      - name: Build the native App (macOS)'
  expect(
    lines.filter((line) => line === header),
    'one native App build step'
  ).toHaveLength(1)
  const start = lines.indexOf(header)
  const end = lines.findIndex((line, index) => index > start && /^ {6}- /.test(line))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

function targetBlock(name: string): string {
  const targets = project.split(/^targets:\n/m)[1]?.split(/^\S/m)[0] ?? ''
  const blocks = targets.split(/^(?= {2}\S)/m)
  const matches = blocks.filter((block) => block.startsWith(`  ${name}:\n`))
  expect(matches, `one ${name} target`).toHaveLength(1)
  return matches[0]!
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
    const command = step
      .match(/^ {8}run: \|\n([\s\S]*)$/m)?.[1]
      ?.replace(/\s*\\\n\s*/g, ' ')
      .trim()

    expect(job).toMatch(/^ {4}runs-on: macos-latest$/m)
    expect(step).toMatch(/^ {8}working-directory: native-app$/m)
    expect(step).not.toMatch(/^ {8}(?:if|shell):/m)
    expect(project).toContain('schemes:\n  Metis:\n    build:\n      targets:\n        Metis: all\n')
    expect(command).toBe(
      'xcodebuild -project Metis.xcodeproj -scheme Metis -configuration Debug ' +
        "-destination 'generic/platform=macOS' CODE_SIGNING_ALLOWED=NO build"
    )
  })

  it('keeps Swift 6 and complete strict concurrency enabled for the App target', () => {
    const app = targetBlock('Metis')
    expect(app.match(/^ {8}SWIFT_VERSION:.*$/gm)).toEqual(['        SWIFT_VERSION: "6.0"'])
    expect(app.match(/^ {8}SWIFT_STRICT_CONCURRENCY:.*$/gm)).toEqual(['        SWIFT_STRICT_CONCURRENCY: complete'])
  })
})

describe('native hosted persistence tests', () => {
  it('compiles the production store into a hostless strict Swift 6 test target', () => {
    const target = targetBlock('MetisPersistenceTests')
    expect(target).toContain('    type: bundle.unit-test\n    platform: macOS')
    expect(target.match(/^ {6}- path: .*$/gm)).toEqual([
      '      - path: App/Store/PersistedModels.swift',
      '      - path: Tests/MeetingPersistenceTests.swift'
    ])
    expect(target).toContain('    dependencies:\n      - package: MetisKit\n')
    expect(target.match(/^ {8}SWIFT_VERSION:.*$/gm)).toEqual(['        SWIFT_VERSION: "6.0"'])
    expect(target.match(/^ {8}SWIFT_STRICT_CONCURRENCY:.*$/gm)).toEqual(['        SWIFT_STRICT_CONCURRENCY: complete'])
    expect(target).not.toMatch(/TEST_HOST|BUNDLE_LOADER|target: Metis\b|MetisApp\.swift/)
    expect(project).toContain('      targets:\n        - MetisPersistenceTests\n')
  })

  it('runs blocking XCTest under an owned hosted home before the unchanged app builds', () => {
    const job = nativeJob()
    const matches = job
      .split(/^(?=      - )/m)
      .filter((step) => step.startsWith('      - name: Test native meeting persistence\n'))
    expect(matches).toHaveLength(1)
    const step = matches[0]!
    expect(step).toContain('working-directory: native-app')
    expect(step).toContain('test "$CI" = true')
    expect(step).toContain('test "$GITHUB_ACTIONS" = true')
    expect(step).toContain('mktemp -d "$RUNNER_TEMP/metis-persistence-home-XXXXXX"')
    expect(step).toContain('metis_test_root="$(cd "$metis_test_root" && pwd -P)"')
    for (const key of ['HOME', 'CFFIXED_USER_HOME', 'METIS_TEST_HOME']) {
      expect(step).toContain(`export ${key}="$metis_test_root"`)
      expect(step).toContain(`export TEST_RUNNER_${key}="$metis_test_root"`)
    }
    expect(step).toContain('export TMPDIR="$metis_test_root/tmp"')
    expect(step).toContain('export TEST_RUNNER_TMPDIR="$metis_test_root/tmp"')
    for (const key of ['CI', 'GITHUB_ACTIONS', 'RUNNER_TEMP']) {
      expect(step).toContain(`export TEST_RUNNER_${key}="$${key}"`)
    }
    const command = step.replace(/\s*\\\n\s*/g, ' ')
    expect(command).toContain(
      'xcodebuild test -project Metis.xcodeproj -scheme MetisPersistenceTests -configuration Debug ' +
        "-destination 'platform=macOS' -derivedDataPath \"$metis_test_root/DerivedData\" " +
        '-resultBundlePath "$metis_test_root/PersistenceTests.xcresult" CODE_SIGNING_ALLOWED=NO'
    )
    expect(step).not.toMatch(/continue-on-error|\|\|\s*true|^ {8}if:|rm -rf|open -[an]|\.app\/Contents\/MacOS\//m)
    expect(job).toContain('Generate the Xcode project')
    expect(job.indexOf('Generate the Xcode project')).toBeLessThan(job.indexOf(step))
    expect(job.indexOf(step)).toBeLessThan(job.indexOf('Build the native App (macOS)'))
  })
})

describe('native hosted Release ZIP baseline', () => {
  const namedStep = (name: string): string => {
    const step = nativeJob()
      .split(/^(?=      - )/m)
      .find((candidate) => candidate.startsWith(`      - name: ${name}\n`))
    expect(step, `native step ${name}`).toBeDefined()
    return step!
  }

  it('preserves both existing test commands and the Debug build before the Release baseline', () => {
    const job = nativeJob()
    expect(job).toContain('run: bash scripts/hermetic/run-swift-tests.sh native-app/MetisKit')
    expect(job).toContain('run: bash native/mac-helper/Tests/run-helper-tests.sh')
    expect(job).toMatch(/^ {4}timeout-minutes: 30$/m)
    expect(job.indexOf('Build the native App (macOS)')).toBeLessThan(job.indexOf('Allocate native package workspace'))
    expect(job).not.toMatch(/continue-on-error:\s*true/)
  })

  it('allocates owned directories and keeps pre/post source guards separate from the unchanged builder', () => {
    const job = nativeJob()
    const allocate = namedStep('Allocate native package workspace')
    const before = namedStep('Require clean native project before Release')
    const build = namedStep('Build native Release ZIP')
    const after = namedStep('Require clean native project after Release')
    expect(allocate).toContain('node scripts/verify-native-mac-package.mjs prepare')
    expect(build).toContain('node scripts/build-native-mac.mjs --out-dir "$NATIVE_OUTPUT"')
    expect(build).toContain('NATIVE_OUTPUT: ${{ steps.native_paths.outputs.output }}')
    for (const guard of [before, after]) {
      expect(guard).toContain('git diff --exit-code -- native-app/project.yml')
      expect(guard).toContain('git diff --cached --exit-code -- native-app/project.yml')
    }
    expect(after).toMatch(/^ {8}if: always\(\)$/m)
    expect(job.indexOf(allocate)).toBeLessThan(job.indexOf(before))
    expect(job.indexOf(before)).toBeLessThan(job.indexOf(build))
    expect(job.indexOf(build)).toBeLessThan(job.indexOf(after))
    expect(build).not.toMatch(/\|\|\s*true|continue-on-error|xcodebuild/)
  })

  it('verifies only after builder and post-source guard success, then uploads exactly two named files', () => {
    const verify = namedStep('Verify native Release ZIP without launching')
    const upload = namedStep('Upload native package baseline')
    expect(verify).toContain(
      "if: success() && steps.native_release.outcome == 'success' && steps.native_source_after.outcome == 'success'"
    )
    expect(verify).toContain('node scripts/verify-native-mac-package.mjs verify')
    expect(verify).toContain('NATIVE_METADATA: ${{ steps.native_paths.outputs.metadata }}')
    expect(verify).toContain(
      'run: |\n          node scripts/verify-native-mac-package.mjs verify\n          cat "$NATIVE_METADATA"\n'
    )
    expect(verify).not.toMatch(/\|\|\s*true|continue-on-error|^ {8}shell:/m)
    expect(upload).toContain("if: success() && steps.native_verify.outcome == 'success'")
    expect(upload).toContain('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02')
    expect(upload).toContain('if-no-files-found: error')
    expect(upload).toContain('retention-days: 3')
    expect(upload).toContain('compression-level: 0')
    expect(upload).toContain(
      'path: |\n            ${{ steps.native_paths.outputs.zip }}\n' +
        '            ${{ steps.native_paths.outputs.metadata }}'
    )
    expect(upload).not.toContain('*')
  })

  it('always cleans only the allocated workspace after upload without launching or publishing', () => {
    const job = nativeJob()
    const cleanup = namedStep('Clean owned native package workspace')
    expect(cleanup).toContain("if: always() && steps.native_paths.outputs.root != ''")
    expect(cleanup).toContain('NATIVE_PACKAGE_ROOT: ${{ steps.native_paths.outputs.root }}')
    expect(cleanup).toContain('NATIVE_PACKAGE_OWNER: ${{ steps.native_paths.outputs.owner_digest }}')
    expect(cleanup).toContain('node scripts/verify-native-mac-package.mjs cleanup')
    expect(job.indexOf(cleanup)).toBeGreaterThan(job.indexOf(namedStep('Upload native package baseline')))
    expect(job).not.toMatch(/gh release|git push|open -[an]|\.app\/Contents\/MacOS\//)
    expect(job).not.toContain('rm -rf')
  })
})
