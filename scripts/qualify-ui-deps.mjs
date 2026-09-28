#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const UI_DEPENDENCY_REVIEW = [
  {
    packageName: 'thinking-orbs',
    version: '0.3.1',
    license: 'MIT',
    adopted: true,
    lockfileRequired: true,
    nativePort: 'none',
    decision: 'Qualified as the renderer Circle orb dependency already adopted by the desktop app.'
  },
  {
    packageName: 'border-beam',
    version: '1.4.1',
    license: 'MIT',
    adopted: false,
    lockfileRequired: false,
    nativePort: 'not-adopted',
    decision: 'Qualified as a pinned React candidate only; native ports are not adopted for Electron desktop.'
  },
  {
    packageName: 'voice-glow',
    version: '0.2.0',
    license: 'MIT',
    adopted: false,
    lockfileRequired: false,
    nativePort: 'none',
    decision: 'Qualified as a pinned React candidate only; no native package is adopted for Electron desktop.'
  }
]

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function parseArgs(argv) {
  const args = { out: 'out/m2-0092-ui-deps', metadata: true, audit: true }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--out') {
      args.out = argv[++i]
    } else if (arg === '--no-metadata') {
      args.metadata = false
    } else if (arg === '--no-audit') {
      args.audit = false
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return args
}

export function collectLockfilePins(packageJson, packageLock, review = UI_DEPENDENCY_REVIEW) {
  const root = packageLock.packages?.['']
  if (!root) throw new Error('package-lock.json is missing the root package entry')

  return review.map((candidate) => {
    const declared =
      root.dependencies?.[candidate.packageName] ??
      root.devDependencies?.[candidate.packageName] ??
      packageJson.dependencies?.[candidate.packageName] ??
      packageJson.devDependencies?.[candidate.packageName] ??
      null
    const locked = packageLock.packages?.[`node_modules/${candidate.packageName}`] ?? null
    return {
      packageName: candidate.packageName,
      expectedVersion: candidate.version,
      packageJsonRange: declared,
      lockfileVersion: locked?.version ?? null,
      lockfileLicense: locked?.license ?? null,
      adopted: candidate.adopted
    }
  })
}

export function assertQualificationInputs(packageJson, packageLock, review = UI_DEPENDENCY_REVIEW) {
  const pins = collectLockfilePins(packageJson, packageLock, review)
  const failures = []

  for (const candidate of review) {
    const pin = pins.find((p) => p.packageName === candidate.packageName)
    if (candidate.adopted || candidate.lockfileRequired) {
      if (pin.packageJsonRange !== candidate.version) {
        failures.push(`${candidate.packageName} must be exact-pinned to ${candidate.version} in package.json`)
      }
      if (pin.lockfileVersion !== candidate.version) {
        failures.push(`${candidate.packageName} must resolve to ${candidate.version} in package-lock.json`)
      }
      if (pin.lockfileLicense !== candidate.license) {
        failures.push(`${candidate.packageName} lockfile license must be ${candidate.license}`)
      }
    } else if (pin.packageJsonRange !== null || pin.lockfileVersion !== null) {
      failures.push(`${candidate.packageName} is not adopted; do not add it to package.json/package-lock.json`)
    }

    if (candidate.nativePort !== 'none' && candidate.nativePort !== 'not-adopted') {
      failures.push(`${candidate.packageName} has an unreconciled native port decision`)
    }
  }

  if (failures.length) {
    throw new Error(failures.join('\n'))
  }

  return pins
}

function npmJson(args, options = {}) {
  return JSON.parse(execFileSync('npm', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options
  }))
}

function npmAuditOmitDev() {
  try {
    return npmJson(['audit', '--omit=dev', '--json'])
  } catch (error) {
    if (error.status === 1 && error.stdout) return JSON.parse(error.stdout.toString())
    throw error
  }
}

function npmPackageMetadata(candidate) {
  return npmJson([
    'view',
    `${candidate.packageName}@${candidate.version}`,
    'name',
    'version',
    'license',
    'dependencies',
    'peerDependencies',
    'repository',
    'homepage',
    'dist.integrity',
    '--json'
  ])
}

function summarizeAudit(report) {
  const counts = report.metadata?.vulnerabilities ?? {}
  return {
    auditReportVersion: report.auditReportVersion ?? null,
    omittedDevDependencies: true,
    vulnerabilities: {
      info: counts.info ?? 0,
      low: counts.low ?? 0,
      moderate: counts.moderate ?? 0,
      high: counts.high ?? 0,
      critical: counts.critical ?? 0,
      total: counts.total ?? 0
    }
  }
}

function buildReport({ pins, metadata, audit }) {
  return {
    ticket: 'M2-0092',
    evidenceLevel: 'DESIGNED',
    generatedAt: new Date().toISOString(),
    dependencies: UI_DEPENDENCY_REVIEW.map((candidate) => {
      const pin = pins.find((p) => p.packageName === candidate.packageName)
      const npm = metadata?.[candidate.packageName] ?? null
      return {
        packageName: candidate.packageName,
        pinnedVersion: candidate.version,
        adopted: candidate.adopted,
        packageJsonRange: pin?.packageJsonRange ?? null,
        lockfileVersion: pin?.lockfileVersion ?? null,
        expectedLicense: candidate.license,
        observedLicense: npm?.license ?? pin?.lockfileLicense ?? null,
        runtimeDependencies: npm?.dependencies ?? null,
        peerDependencies: npm?.peerDependencies ?? null,
        nativePort: candidate.nativePort,
        decision: candidate.decision
      }
    }),
    nativePackageDecision: {
      minimumMacOS: {
        electronRuntime: 'macOS 12 per Electron runtime documentation recorded in repo architecture docs',
        macHelper: 'macOS 13 deployment target in the Swift helper build script',
        metisKit: 'macOS 14 Swift package platform',
        appleIntelligenceModels: 'macOS 26 availability-gated runtime'
      },
      outcome: 'Do not adopt native border-beam or voice-glow ports for this Electron desktop ticket; use renderer packages only.'
    },
    audit: audit ? summarizeAudit(audit) : null
  }
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const outDir = resolve(repoRoot, args.out)
  mkdirSync(outDir, { recursive: true })

  const packageJson = readJson(join(repoRoot, 'package.json'))
  const packageLock = readJson(join(repoRoot, 'package-lock.json'))
  const pins = assertQualificationInputs(packageJson, packageLock)

  const metadata = {}
  if (args.metadata) {
    for (const candidate of UI_DEPENDENCY_REVIEW) {
      const observed = npmPackageMetadata(candidate)
      if (observed.version !== candidate.version) {
        throw new Error(`${candidate.packageName} metadata resolved ${observed.version}, expected ${candidate.version}`)
      }
      if (observed.license !== candidate.license) {
        throw new Error(`${candidate.packageName} metadata license ${observed.license}, expected ${candidate.license}`)
      }
      metadata[candidate.packageName] = observed
    }
    writeJson(join(outDir, 'npm-metadata.json'), metadata)
  }

  let audit = null
  if (args.audit) {
    audit = npmAuditOmitDev()
    writeJson(join(outDir, 'npm-audit-omit-dev.json'), audit)
  }

  const report = buildReport({ pins, metadata, audit })
  writeJson(join(outDir, 'ui-dependency-review.json'), report)
  console.log(`[qualify-ui-deps] wrote ${outDir}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`[qualify-ui-deps] ${error.message}`)
    process.exit(1)
  }
}
