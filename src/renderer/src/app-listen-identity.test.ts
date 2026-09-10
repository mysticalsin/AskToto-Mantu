import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { nextMeetingStart } from './lib/recap-write-coordinator'

describe('actual App Listen identity arguments', () => {
  it('passes the just-assigned persisted meeting start, not a second timestamp', () => {
    const source = ts.createSourceFile('App.tsx', readFileSync(join(__dirname, 'App.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const boundaries: ts.Node[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'startListen' && node.initializer) {
        const inspect = (child: ts.Node): void => {
          if (ts.isBinaryExpression(child) && child.left.getText(source) === 'meetingStartRef.current') boundaries.push(child)
          if (ts.isCallExpression(child) && child.expression.getText(source) === 'listen.start') boundaries.push(child)
          ts.forEachChild(child, inspect)
        }
        inspect(node.initializer)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(boundaries).toHaveLength(2)
    const start = vi.fn()
    const context = vm.createContext({
      meetingStartRef: { current: 8e15 }, nextMeetingStart,
      settings: { audioSource: 'both', asrQuality: 'fast', asrEngine: 'parakeet', asrLanguage: 'English' },
      listen: { start }, Date: { now: () => 42 }
    })
    const code = ts.transpileModule(boundaries.map(node => `${node.getText(source)};`).join('\n'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
    }).outputText
    vm.runInContext(code, context, { timeout: 1_000 })
    expect(start).toHaveBeenCalledExactlyOnceWith('both', 'fast', 'parakeet', 'English', 8e15 + 1)
  })
})
