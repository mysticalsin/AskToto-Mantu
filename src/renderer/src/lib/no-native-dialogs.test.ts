import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOTS = ['src/renderer/src', 'intelligence/src'] as const
const EXTENSIONS = new Set(['.ts', '.tsx'])
const NATIVE_DIALOGS = new Set(['alert', 'confirm', 'prompt'])
const GLOBALS = new Set(['window', 'globalThis', 'self'])

function extensionOf(file: string): string {
  const dot = file.lastIndexOf('.')
  return dot === -1 ? '' : file.slice(dot)
}

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...filesUnder(path))
    } else if (entry.isFile() && EXTENSIONS.has(extensionOf(path))) {
      out.push(path)
    }
  }
  return out
}

function stringValue(node: ts.Expression, strings: Map<string, string>): string | null {
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isIdentifier(node)) return strings.get(node.text) ?? null
  return null
}

function globalObjectName(node: ts.Expression): string | null {
  if (ts.isIdentifier(node) && GLOBALS.has(node.text)) return node.text
  return null
}

function dialogMemberName(node: ts.Expression, strings: Map<string, string>): string | null {
  if (ts.isPropertyAccessExpression(node) && globalObjectName(node.expression) && NATIVE_DIALOGS.has(node.name.text)) {
    return node.name.text
  }
  if (ts.isElementAccessExpression(node) && globalObjectName(node.expression)) {
    const name = stringValue(node.argumentExpression, strings)
    return name && NATIVE_DIALOGS.has(name) ? name : null
  }
  return null
}

function scanSource(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const strings = new Map<string, string>()
  const aliases = new Map<string, string>()
  const findings: string[] = []

  const collectAliases = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name) && node.initializer) {
        if (ts.isStringLiteralLike(node.initializer) && NATIVE_DIALOGS.has(node.initializer.text)) {
          strings.set(node.name.text, node.initializer.text)
        }
        const member = dialogMemberName(node.initializer, strings)
        if (member) aliases.set(node.name.text, member)
      }
      if (ts.isObjectBindingPattern(node.name) && node.initializer && globalObjectName(node.initializer)) {
        for (const element of node.name.elements) {
          const property = element.propertyName ?? element.name
          if (!ts.isIdentifier(property) || !ts.isIdentifier(element.name)) continue
          if (NATIVE_DIALOGS.has(property.text)) aliases.set(element.name.text, property.text)
        }
      }
    }
    ts.forEachChild(node, collectAliases)
  }

  const calledDialogName = (node: ts.Expression): string | null => {
    if (ts.isIdentifier(node)) return NATIVE_DIALOGS.has(node.text) || aliases.has(node.text) ? (aliases.get(node.text) ?? node.text) : null
    return dialogMemberName(node, strings)
  }

  const scanCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calledDialogName(node.expression)
      if (name) {
        const pos = source.getLineAndCharacterOfPosition(node.expression.getStart(source))
        findings.push(`${relative(process.cwd(), file)}:${pos.line + 1}:${pos.character + 1} uses native ${name}()`)
      }
    }
    ts.forEachChild(node, scanCalls)
  }

  collectAliases(source)
  scanCalls(source)
  return findings
}

describe('renderer native dialogs', () => {
  it('bans alert/confirm/prompt in renderer and intelligence source, including aliases and computed access', () => {
    const findings = ROOTS.flatMap((root) => filesUnder(root).flatMap(scanSource))
    expect(findings).toEqual([])
  })

  it('proves the AST scanner catches direct, aliased, destructured, and computed native dialog calls', () => {
    const fixture = join(process.cwd(), 'src/renderer/src/lib/__native-dialog-fixture.ts')
    const source = ts.createSourceFile(fixture, `
      window.confirm('direct')
      const nativeConfirm = window.confirm
      nativeConfirm('alias')
      const { alert: nativeAlert } = window
      nativeAlert('destructured')
      const promptName = 'prompt'
      globalThis[promptName]('computed')
    `, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const text = source.getFullText()
    const strings = new Map<string, string>()
    const aliases = new Map<string, string>()
    const findings: string[] = []

    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node)) {
        if (ts.isIdentifier(node.name) && node.initializer) {
          if (ts.isStringLiteralLike(node.initializer)) strings.set(node.name.text, node.initializer.text)
          const member = dialogMemberName(node.initializer, strings)
          if (member) aliases.set(node.name.text, member)
        }
        if (ts.isObjectBindingPattern(node.name) && node.initializer && globalObjectName(node.initializer)) {
          for (const element of node.name.elements) {
            const property = element.propertyName ?? element.name
            if (ts.isIdentifier(property) && ts.isIdentifier(element.name)) aliases.set(element.name.text, property.text)
          }
        }
      }
      ts.forEachChild(node, collect)
    }
    const scan = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const expression = node.expression
        const direct = ts.isIdentifier(expression) ? aliases.get(expression.text) ?? (NATIVE_DIALOGS.has(expression.text) ? expression.text : null) : dialogMemberName(expression, strings)
        if (direct) findings.push(text.slice(expression.getStart(source), expression.getEnd()))
      }
      ts.forEachChild(node, scan)
    }

    collect(source)
    scan(source)
    expect(findings).toEqual(['window.confirm', 'nativeConfirm', 'nativeAlert', 'globalThis[promptName]'])
  })
})
