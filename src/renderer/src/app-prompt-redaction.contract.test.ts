/**
 * Contract: every ask built from captured speech or screen text is redacted before it leaves the device
 * (Q01 / D5-1, D5-2, D5-5). Main redacts only `req.transcript` and prompts flagged `redactPrompt`, and must
 * never touch the user's typed text, so each renderer call site that embeds the transcript in `prompt`
 * has to opt in explicitly. A TypeScript AST walk over App.tsx finds every `*.run({ prompt })` and
 * `askScreen(prompt, opts)` call, resolves the prompt expression one declaration deep, and fails any
 * transcript-derived site that is neither flagged nor routed through the redacting helpers. The expected
 * enclosing-function list is explicit, so a new site fails until a human classifies it.
 */
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../../test-helpers/module-source'

const appModule = readModuleSource(__dirname, './App')
const file = ts.createSourceFile(appModule.path, appModule.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

interface Site {
  fn: string
  callee: string
  resolved: string
  hasRedactFlag: boolean
  node: ts.CallExpression
}

const TRANSCRIPT_TOKEN = /listen\.text\(|\btx\b|\btranscript\b|transcriptToText\(/

function propOf(obj: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | undefined {
  return obj.properties.find((p) => p.name !== undefined && p.name.getText(file) === name)
}

function propInitializerText(p: ts.ObjectLiteralElementLike): string {
  if (ts.isShorthandPropertyAssignment(p)) return p.name.getText(file)
  if (ts.isPropertyAssignment(p)) return p.initializer.getText(file)
  return p.getText(file)
}

function enclosingName(node: ts.Node): string {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (ts.isCallExpression(cur) && cur.expression.getText(file) === 'useEffect') return 'useEffect'
    if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name) && cur.initializer) {
      const init = cur.initializer
      const isHandler =
        ts.isArrowFunction(init) ||
        ts.isFunctionExpression(init) ||
        (ts.isCallExpression(init) && /^use(Callback|Memo)$/.test(init.expression.getText(file)))
      if (isHandler) return cur.name.text
    }
  }
  return '<top>'
}

function enclosingFunction(node: ts.Node): ts.Node {
  let found: ts.Node = file
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur) || ts.isFunctionDeclaration(cur)) found = cur
    if (
      ts.isVariableDeclaration(cur) &&
      cur.initializer &&
      ts.isCallExpression(cur.initializer) &&
      /^use(Callback|Memo)$/.test(cur.initializer.expression.getText(file))
    )
      return cur.initializer
    if (ts.isCallExpression(cur) && cur.expression.getText(file) === 'useEffect') return cur
  }
  return found
}

/** Text of every local declaration (`const x = …` or `const { x } = …`) of the identifiers used in `text`. */
function resolve(scope: ts.Node, text: string, depth = 0): string {
  if (depth > 3) return text
  const ids = new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? [])
  let out = text
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const names: string[] = []
      if (ts.isIdentifier(n.name)) names.push(n.name.text)
      else if (ts.isObjectBindingPattern(n.name)) {
        for (const el of n.name.elements) if (ts.isIdentifier(el.name)) names.push(el.name.text)
      }
      if (names.some((nm) => ids.has(nm))) {
        out += `\n${resolve(scope, n.initializer.getText(file), depth + 1)}`
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(scope)
  return out
}

function collectSites(): Site[] {
  const sites: Site[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(file)
      const scope = enclosingFunction(node)
      if (/\.run$/.test(callee) && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
        const obj = node.arguments[0]
        const prompt = propOf(obj, 'prompt')
        if (prompt) {
          const flag = propOf(obj, 'redactPrompt')
          sites.push({
            fn: enclosingName(node),
            callee,
            resolved: resolve(scope, propInitializerText(prompt)),
            hasRedactFlag: !!flag && propInitializerText(flag) !== 'false',
            node
          })
        }
      } else if (callee === 'askScreen' && node.arguments[0]) {
        const opts = node.arguments[1]
        const flag = opts && ts.isObjectLiteralExpression(opts) ? propOf(opts, 'redactPrompt') : undefined
        sites.push({
          fn: enclosingName(node),
          callee,
          resolved: resolve(scope, node.arguments[0].getText(file)),
          hasRedactFlag: !!flag && propInitializerText(flag) !== 'false',
          node
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return sites
}

const sites = collectSites()
const derived = sites.filter((s) => TRANSCRIPT_TOKEN.test(s.resolved))

describe('transcript-derived asks redact (Q01)', () => {
  it('finds the ask call sites (the AST walk has not drifted)', () => {
    expect(sites.length).toBeGreaterThan(15)
  })

  it('every transcript-derived ask redacts', () => {
    const unprotected = derived.filter((s) => {
      if (s.hasRedactFlag) return false
      // Typed question + transcript: only the transcript part is redacted, in the renderer.
      return !/transcriptForPrompt\(|withContext\([\s\S]*redact/.test(s.resolved)
    })
    expect(unprotected.map((s) => `${s.fn}: ${s.callee}`)).toEqual([])
  })

  it('the classified set of transcript-derived call sites is explicit', () => {
    const fns = [...new Set(derived.map((s) => s.fn))].sort()
    expect(fns).toEqual(
      ['assist', 'generateColdCallCoaching', 'onQuickAction', 'spotlightRef', 'submit', 'useEffect', 'whatNext'].sort()
    )
  })

  it('askScreen forwards redactPrompt into all three of its asks', () => {
    const decl = file.statements
      .flatMap((s) => (ts.isFunctionDeclaration(s) || ts.isVariableStatement(s) ? [s] : []))
      .map((s) => s.getText(file))
    expect(decl.length).toBeGreaterThan(0)
    const src = file.getText()
    const start = src.indexOf('const askScreen = useCallback(')
    const end = src.indexOf('const assist = useCallback(')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const body = src.slice(start, end)
    const runs = body.match(/ask\.run\(\{[\s\S]*?\}\)/g) ?? []
    expect(runs.length).toBe(3)
    for (const r of runs) expect(r).toMatch(/redactPrompt:\s*opts\?\.redactPrompt/)
  })

  it('typed text is never flagged: the typed screen-asks pass no redactPrompt', () => {
    const typed = sites.filter(
      (s) => s.callee === 'askScreen' && /^(q|qScreen)$/.test(s.node.arguments[0]!.getText(file))
    )
    expect(typed.length).toBeGreaterThan(0)
    for (const s of typed) expect(s.hasRedactFlag).toBe(false)
  })

  it('fact-check is built only by the bounded, redacting buildFactCheckRequest', () => {
    const src = file.getText()
    expect(src).toMatch(/buildFactCheckRequest\(/)
    expect(src).not.toMatch(/buildFactCheckClaimPrompt\(/)
  })
})

describe('transcript tails (D5-5)', () => {
  it('every non-recap ask that sends a transcript slices it to the tail', () => {
    const bad: string[] = []
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        /\.run$/.test(node.expression.getText(file)) &&
        node.arguments[0] &&
        ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        const obj = node.arguments[0]
        const tx = propOf(obj, 'transcript')
        const mode = propOf(obj, 'mode')
        const modeText = mode ? propInitializerText(mode) : ''
        if (tx && !/summary|recap/.test(modeText)) {
          const text = propInitializerText(tx)
          if (!/transcriptTail\(|\.slice\(-/.test(text)) bad.push(`${enclosingName(node)}: ${text}`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
    expect(bad).toEqual([])
  })
})
