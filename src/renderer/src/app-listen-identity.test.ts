import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { nextMeetingStart } from './lib/recap-write-coordinator'
import { resolveListenEngine } from './lib/listen-startup-policy'

/** Extract the source, meeting start, engine, and listen.start boundaries from App.tsx. */
function extractStartListenBoundaries(): { source: ts.SourceFile; boundaries: ts.Node[] } {
  const source = ts.createSourceFile(
    'App.tsx',
    readFileSync(join(__dirname, 'App.tsx'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const boundaries: ts.Node[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'startListen' && node.initializer) {
      const inspect = (child: ts.Node): void => {
        if (ts.isVariableDeclaration(child) && ['source', 'engine'].includes(child.name.getText(source))) boundaries.push(child)
        if (ts.isBinaryExpression(child) && child.left.getText(source) === 'meetingStartRef.current') boundaries.push(child)
        if (ts.isCallExpression(child) && child.expression.getText(source) === 'listen.start') boundaries.push(child)
        ts.forEachChild(child, inspect)
      }
      inspect(node.initializer)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { source, boundaries }
}

function runStartListenSnippet(
  source: ts.SourceFile,
  boundaries: ts.Node[],
  useCloud: boolean,
  audioSource = 'both'
): ReturnType<typeof vi.fn> {
  const start = vi.fn()
  const context = vm.createContext({
    meetingStartRef: { current: 8e15 },
    nextMeetingStart,
    settings: {
      audioSource,
      asrQuality: 'fast',
      asrEngine: 'parakeet',
      asrLanguage: 'English',
      ...(useCloud ? {
        enterpriseLive: { managed: true, inferenceMode: 'cloud-only', summaryOnly: false },
        cloudSttProvider: 'cloudflare-nova3'
      } : {})
    },
    resolveListenEngine,
    acceptedCloudConsent: undefined,
    listen: { start },
    Date: { now: () => 42 }
  })
  const code = ts.transpileModule(boundaries.map(node =>
    `${ts.isVariableDeclaration(node) ? 'const ' : ''}${node.getText(source)};`
  ).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText
  vm.runInContext(code, context, { timeout: 1_000 })
  return start
}

describe('actual App Listen identity arguments', () => {
  it('passes the just-assigned persisted meeting start, not a second timestamp', () => {
    const { source, boundaries } = extractStartListenBoundaries()
    expect(boundaries).toHaveLength(4)
    // shouldUseCloudSttEngine → false: on-device engine stays asrEngine (parakeet)
    const start = runStartListenSnippet(source, boundaries, false)
    expect(start).toHaveBeenCalledExactlyOnceWith('both', 'fast', 'parakeet', 'English', 8e15 + 1, undefined)
  })

  it('passes cloud engine when shouldUseCloudSttEngine resolves true', () => {
    const { source, boundaries } = extractStartListenBoundaries()
    expect(boundaries).toHaveLength(4)
    const start = runStartListenSnippet(source, boundaries, true)
    expect(start).toHaveBeenCalledExactlyOnceWith('both', 'fast', 'cloud', 'English', 8e15 + 1, undefined)
  })

  it('passes the selected microphone source through the extracted App declaration', () => {
    const { source, boundaries } = extractStartListenBoundaries()
    expect(boundaries).toHaveLength(4)
    const start = runStartListenSnippet(source, boundaries, false, 'mic')
    expect(start).toHaveBeenCalledExactlyOnceWith('mic', 'fast', 'parakeet', 'English', 8e15 + 1, undefined)
  })
})
