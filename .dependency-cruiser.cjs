/**
 * Architecture fitness functions FF-01..FF-03: the rules that need the resolved module graph.
 *
 * Every rule name starts with its fitness-function id (`ff01-`, `ff02-`, `ff03-`).
 * scripts/check-architecture.mjs counts violations per id and file against
 * scripts/architecture-baseline.json and rejects any rule name without that prefix.
 *
 * Severity is the enforcement mode:
 * - error: production code never does this. `npm run check:layering` exits non-zero on any error.
 * - warn: existing debt that may only shrink, held per file by the ratchet.
 */
const TEST_FILE = '\\.(test|spec)\\.tsx?$'

// Modules the app loads by file path rather than by import: the electron-vite inputs in
// electron.vite.config.ts, the scripts of src/renderer/{index,decoder}.html, and the
// `new Worker(new URL(...))` target in listen.ts.
const ENTRY_POINTS = [
  '^src/main/(index|parakeet-asr-host|parakeet-extract-host|speaker-embedding-host|whisper-asr-host)\\.ts$',
  '^src/preload/(index|intelligence|import-decoder)\\.ts$',
  '^src/renderer/src/(main\\.tsx|import-decoder\\.ts)$',
  '^src/renderer/src/lib/whisper\\.worker\\.ts$',
]

/**
 * One layer boundary, as two rules: production code must never cross it (error), and a test that
 * crosses it is ratcheted debt (warn), because tests follow the production rules.
 */
function boundary(name, comment, fromPath, to) {
  return [
    { name: `ff01-${name}`, comment, severity: 'error', from: { path: fromPath, pathNot: TEST_FILE }, to },
    { name: `ff01-${name}-in-tests`, comment, severity: 'warn', from: { path: `${fromPath}.*${TEST_FILE}` }, to },
  ]
}

module.exports = {
  forbidden: [
    ...boundary('renderer-imports-main-or-preload',
      'The renderer reaches main only through the preload bridge and src/shared.',
      '^src/renderer/', { path: '^src/(main|preload)/' }),
    ...boundary('preload-imports-main-or-renderer',
      'The preload bundle imports only src/shared, Electron and Node.',
      '^src/preload/', { path: '^src/(main|renderer)/' }),
    ...boundary('main-imports-renderer-or-preload',
      'The main bundle never contains renderer or preload code.',
      '^src/main/', { path: '^src/(renderer|preload)/' }),
    ...boundary('shared-imports-a-process',
      'src/shared is imported by every process, so it imports none of them.',
      '^src/shared/', { path: '^src/(main|renderer|preload)/' }),
    ...boundary('infra-imports-features',
      'Features depend on infrastructure, never the reverse.',
      '^src/main/infra/', { path: '^src/main/features/' }),
    ...boundary('feature-imports-feature-internals',
      'Another feature is reached only through its index.ts.',
      '^src/main/features/([^/]+)/',
      { path: '^src/main/features/[^/]+/', pathNot: ['^src/main/features/$1/', '^src/main/features/[^/]+/index\\.ts$'] }),
    {
      name: 'ff01-contracts-import-beyond-zod',
      comment: 'Contracts are plain zod schemas: they import zod and each other, nothing else.',
      severity: 'error',
      from: { path: '^src/shared/contracts/', pathNot: TEST_FILE },
      // (^|/) because a symlinked node_modules resolves to its real path.
      to: { pathNot: ['^src/shared/contracts/', '(^|/)node_modules/zod/'] },
    },
    {
      name: 'ff02-import-cycle',
      comment: 'Every module on a cycle loads, tests and changes together with all the others.',
      severity: 'warn',
      from: { path: '^src/' },
      to: { circular: true },
    },
    {
      name: 'ff03-unreachable-from-entry-points',
      comment: 'No entry point reaches this module, so it is dead code (being imported by a test does not count).',
      severity: 'warn',
      from: { path: ENTRY_POINTS },
      to: { path: '^src/.+\\.tsx?$', pathNot: [TEST_FILE, '\\.d\\.ts$', '/__fixtures__/', ...ENTRY_POINTS], reachable: false },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Type-only imports are coupling too: a renderer type imported from main is a layering break.
    tsPreCompilationDeps: true,
    // tsconfig.web.json declares both aliases (@shared/* and @/*); main and preload use only @shared/*.
    tsConfig: { fileName: 'tsconfig.web.json' },
  },
}
