import { isAbsolute, relative, resolve } from 'node:path'

export interface LocalAiPathContext {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

function assertSafeRelativePath(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Local AI resource path must be a non-empty string.')
  }
  if (
    CONTROL_CHARACTERS.test(value) ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value) ||
    value.includes('\\') ||
    value.includes('%') ||
    value.includes('?') ||
    value.includes('#')
  ) {
    throw new Error('Local AI resource path must be a safe POSIX relative path.')
  }

  for (const segment of value.split('/')) {
    if (
      segment.length === 0 ||
      segment === '.' ||
      segment === '..' ||
      segment.endsWith('.') ||
      segment.endsWith(' ')
    ) {
      throw new Error('Local AI resource path contains an unsafe segment.')
    }
  }
}

export function localAiRoot(context: LocalAiPathContext): string {
  return context.isPackaged
    ? resolve(context.resourcesPath, 'local-ai')
    : resolve(context.appPath, 'resources', 'local-ai', 'payload')
}

export function resolveLocalAiResource(
  context: LocalAiPathContext,
  relativePath: string
): string {
  assertSafeRelativePath(relativePath)
  const root = localAiRoot(context)
  const candidate = resolve(root, relativePath)
  const contained = relative(root, candidate)
  if (!contained || contained.startsWith('..') || isAbsolute(contained)) {
    throw new Error('Local AI resource path escapes its root.')
  }
  return candidate
}
