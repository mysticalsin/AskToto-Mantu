/**
 * Contract: every ask built from captured speech or screen text is redacted before it leaves the device
 * (Q01 / D5-1, D5-2, D5-5), and the renderer sends no live transcript at all (G13). Main redacts `req.transcript`,
 * the slots it fills from its own ledger, and prompts flagged `redactPrompt`, and must never touch the user's
 * typed text, so each renderer call site that puts the transcript in a `prompt` has to either flag the prompt or
 * declare the `context` main fills the slot from. A TypeScript AST walk over App.tsx finds every
 * `*.run({ prompt })` and `askScreen(prompt, opts)` call, resolves the prompt expression one declaration deep,
 * and fails any transcript-derived site that does neither. The expected enclosing-function list is explicit, so
 * a new site fails until a human classifies it.
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

const TRANSCRIPT_TOKEN =
  /listen\.text\(|\btx\b|\btranscript\b|transcriptToText\(|withContext\(|assistPrompt\(|TRANSCRIPT_SLOT|noDecisionAsk\(/

/** Whether a call's object declares a `context`, directly or in a conditional spread. */
const declaresContext = (call: ts.Node | undefined): boolean =>
  !!call && ts.isObjectLiteralExpression(call) && /\bcontext\s*:/.test(call.getText(file))

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

  it('every transcript-derived ask redacts: the prompt is flagged, or it declares the context main fills and redacts', () => {
    const unprotected = derived.filter((s) => {
      if (s.hasRedactFlag) return false
      // Typed question + transcript slot: main redacts the slot only, never the typed part.
      const call = s.node.arguments[0]
      return !declaresContext(call) && !/withContext\(/.test(s.resolved)
    })
    expect(unprotected.map((s) => `${s.fn}: ${s.callee}`)).toEqual([])
  })

  it('the classified set of transcript-derived call sites is explicit', () => {
    const fns = [...new Set(derived.map((s) => s.fn))].sort()
    expect(fns).toEqual(
      ['assist', 'generateColdCallCoaching', 'onQuickAction', 'spotlightRef', 'submit', 'whatNext'].sort()
    )
  })

  it('a prompt that embeds a transcript slot declares a context, so main can fill it', () => {
    const slotted = sites.filter(
      (s) => s.callee !== 'askScreen' && /TRANSCRIPT_SLOT|withContext\(|assistPrompt\(/.test(s.resolved)
    )
    expect(slotted.length).toBeGreaterThan(0)
    const missing = slotted.filter((s) => {
      const call = s.node.arguments[0]
      return !declaresContext(call)
    })
    expect(missing.map((s) => `${s.fn}: ${s.callee}`)).toEqual([])
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
    // The slot a screen prompt carries is filled by main: every run declares the context derived from that prompt.
    for (const r of runs) expect(r).toMatch(/context:\s*screenRunContext\(prompt,/)
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

describe('the renderer sends no live transcript (G13, D5-5)', () => {
  const runCalls: Array<{ fn: string; obj: ts.ObjectLiteralExpression }> = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      /\.run$/.test(node.expression.getText(file)) &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    )
      runCalls.push({ fn: enclosingName(node), obj: node.arguments[0] })
    ts.forEachChild(node, visit)
  }
  visit(file)

  it('only a saved-meeting summary or recap puts a `transcript` on a request', () => {
    const bad: string[] = []
    for (const { fn, obj } of runCalls) {
      const tx = propOf(obj, 'transcript')
      const mode = propOf(obj, 'mode')
      const modeText = mode ? propInitializerText(mode) : ''
      if (tx && !/summary|recap/.test(modeText)) bad.push(`${fn}: ${propInitializerText(tx)}`)
    }
    expect(bad).toEqual([])
  })

  it('no ask reads, slices or embeds the live transcript text, except the full-meeting coaching and recap asks', () => {
    const exempt = new Set(['generateColdCallCoaching', 'maybeFireRecap', 'endReview'])
    const bad = runCalls
      .filter(({ fn, obj }) => !exempt.has(fn) && !/summary|recap/.test(propOf(obj, 'mode')?.getText(file) ?? ''))
      .filter(({ obj }) => /listen\.text\(|transcriptTail|\.slice\(-/.test(obj.getText(file)))
    expect(bad.map(({ fn }) => fn)).toEqual([])
  })

  it('the renderer no longer has a transcript tail helper to slice with', () => {
    expect(appModule.text).not.toMatch(/transcriptTail|transcriptForPrompt/)
  })
})
