import { join } from 'node:path'
import ts from 'typescript'

/**
 * Reads the real source text of a module for a source-contract test, addressing it by module specifier
 * (`./App`, `../renderer/src/lib/listen`) rather than by a file name with an extension.
 *
 * The specifier is resolved with the TypeScript compiler's own module resolution, so the test names the
 * module it pins and the compiler decides which file that is, exactly as it does for an import. A specifier
 * that does not resolve to a TypeScript source file throws, so a renamed or removed module fails the test
 * instead of silently reading nothing. Content is returned byte for byte.
 */
export function readModuleSource(fromDir: string, specifier: string): { path: string; text: string } {
  const containingFile = join(fromDir, 'module-source-importer')
  const { resolvedModule } = ts.resolveModuleName(
    specifier,
    containingFile,
    { moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true },
    ts.sys
  )
  const path = resolvedModule?.resolvedFileName
  if (!path || resolvedModule.isExternalLibraryImport || path.endsWith('.d.ts')) {
    throw new Error(`Module ${specifier} did not resolve to a source file from ${fromDir}`)
  }
  const text = ts.sys.readFile(path)
  if (text === undefined) throw new Error(`Could not read module source for ${specifier} at ${path}`)
  return { path, text }
}
