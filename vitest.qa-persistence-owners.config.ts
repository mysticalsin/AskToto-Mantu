import { generateKeyPairSync } from 'node:crypto'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const SOURCE_FIXTURE_ELECTRON_VERSION = '0.0.0-qa-source-fixture'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

const fixtureTarget =
  process.platform === 'win32' && process.arch === 'x64'
    ? 'win32-x64'
    : process.platform === 'darwin' && (process.arch === 'x64' || process.arch === 'arm64')
      ? `darwin-${process.arch}`
      : null

const fixtureKeyPair = fixtureTarget ? generateKeyPairSync('ed25519') : null
const fixtureStamp =
  fixtureTarget && fixtureKeyPair
    ? {
        schema: 'metis-persistence-qa-build-stamp/v1',
        publicKeySpki: fixtureKeyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
        context: {
          repository: 'mysticalsin/AskToto-Mantu',
          workflowRef: 'mysticalsin/AskToto-Mantu/.github/workflows/qa-persistence-owners.yml@refs/heads/fix/qa-hosted-run-owners',
          commit: 'a'.repeat(40),
          runId: '99999999999999999999',
          runAttempt: 1,
          job: 'qa-persistence-owners',
          target: fixtureTarget
        },
        candidateSha256: 'b'.repeat(64),
        implementationSha256: 'c'.repeat(64),
        profileMeasurementSha256: 'd'.repeat(64),
        caseRosterSha256: 'e'.repeat(64),
        runtime: {
          platform: process.platform,
          arch: process.arch,
          node: process.versions.node,
          electron: SOURCE_FIXTURE_ELECTRON_VERSION,
          v8: process.versions.v8,
          modules: process.versions.modules
        },
        qaIdentity: {
          runtimeName: 'asktoto-qa',
          bundleId: 'com.mantu.asktoto.qa',
          executableSha256: 'f'.repeat(64),
          signingMode: process.platform === 'win32' ? 'windows-authenticode' : 'mac-adhoc'
        }
      }
    : null

const fixtureStampBytes = fixtureStamp ? canonical(fixtureStamp) : ''
const privateKeyPem =
  fixtureKeyPair?.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() ?? ''
const electronHost = resolve('scripts/qa/fixtures/persistence-run-owner.electron-host.ts')

const shippingProject = {
  extends: true as const,
  define: { __METIS_QA_IDENTITY__: 'false' },
  test: {
    name: 'qa-persistence-shipping',
    include: [
      'src/main/persistence/qa-run-protocol.test.ts',
      'src/main/persistence/native-key-intent.test.ts'
    ],
    environment: 'node'
  }
}

const c1CoherenceFiles = [
  'src/main/auth.test.ts',
  'src/main/auth-speech-lease.test.ts',
  'src/main/auth-speech-boundary-readers.test.ts',
  'src/main/auth-persistence-observation.test.ts',
  'src/main/persistence/qa-main-action-owner.test.ts',
  'src/main/win-security.test.ts',
  'src/main/store.test.ts',
  'src/main/fresh-lean-speech-defaults.test.ts',
  'src/main/settings-observation.test.ts'
]

const qaOwnerProject = fixtureStamp
  ? [
      {
        extends: true as const,
        define: {
          __METIS_QA_IDENTITY__: 'true',
          __METIS_QA_PERSISTENCE_BUILD_STAMP__: JSON.stringify(fixtureStampBytes)
        },
        resolve: { alias: { electron: electronHost } },
        test: {
          name: 'qa-persistence-source-owners',
          include: [
            'src/main/persistence/qa-run-protocol.qa-case.ts',
            'src/main/persistence/qa-run-owner.qa-case.ts',
            'src/main/persistence/qa-profile-root-owner.qa-case.ts',
            'src/main/persistence/root-registry.qa-case.ts'
          ],
          setupFiles: [electronHost],
          environment: 'node',
          testTimeout: 30_000,
          hookTimeout: 30_000,
          maxWorkers: 1,
          provide: {
            qaPersistenceFixturePrivateKeyPem: privateKeyPem,
            qaPersistenceFixtureBuildStamp: fixtureStampBytes
          }
        }
      }
    ]
  : []

const c1CoherenceProject = fixtureStamp
  ? [
      {
        extends: true as const,
        define: { __METIS_QA_IDENTITY__: 'false' },
        test: {
          name: 'qa-persistence-c1-coherence',
          include: c1CoherenceFiles,
          environment: 'node',
          testTimeout: 30_000,
          hookTimeout: 30_000,
          maxWorkers: 1
        }
      }
    ]
  : []

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared')
    }
  },
  test: {
    projects: [shippingProject, ...qaOwnerProject, ...c1CoherenceProject]
  }
})
