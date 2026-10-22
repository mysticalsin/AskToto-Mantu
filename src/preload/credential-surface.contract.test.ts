import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * G20 (b): nothing the preload hands the renderer carries a credential VALUE. For every function the preload
 * exposes, the declared reply type (the inline type literal, and the interface or type alias it names in shared/)
 * is walked, and any property whose name reads like a credential must be a boolean presence flag or an entry
 * of the reviewed list below. A new reply field named `token`, `apiKey` or `secret` fails here until it is
 * reviewed, which is the point.
 */
const SRC = join(__dirname, '..')
const CREDENTIAL_NAME = /secret|token|licen[sc]e(?!d)|lease|password|credential|api.?key|bearer|jws|cookie|passphrase/i

/**
 * Reviewed fields, keyed `Owner.name` (the interface or function the field belongs to), so approving one `lease`
 * or `token` never approves another. A boolean flag and a number or timestamp need no entry: neither can be a value.
 */
const REVIEWED: Readonly<Record<string, string>> = {
  'ImportAudioPickResult.token': 'opaque one-shot handle for a file the user just picked; main maps it to the path',
  'ImportAudioPickedFile.token': 'opaque one-shot handle for a file the user just picked; main maps it to the path',
  'InputSessionResult.lease':
    'input-session descriptor (ids, revisions, flags); a capability handle, not a stored credential',
  'LicenseStatusResult.licenseServerUrl': 'public licence server address',
  'LicenseStatusResult.licenseCompanyName': 'company display name',
  'operatorStatus.licenseLast4': 'last four characters of the Operator licence, display only',
  'IdentitySnapshot.license': 'MemberLicenseStatus: state, edition, seats, expiry; no key, no lease'
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full)
  }
  return out
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
}

/** name -> declaration, across every shared/ source file. */
function sharedDeclarations(): Map<string, ts.Node> {
  const out = new Map<string, ts.Node>()
  for (const file of walk(join(SRC, 'shared'))) {
    parse(file).forEachChild((node) => {
      if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) out.set(node.name.text, node)
    })
  }
  return out
}

interface Finding {
  where: string
  /** `Owner.name`: the last interface or function in the chain, then the property. */
  id: string
  type: string
}

function collect(
  node: ts.Node,
  decls: Map<string, ts.Node>,
  where: string,
  seen: Set<string>,
  out: Finding[],
  omitted: ReadonlySet<string> = new Set()
): void {
  if (ts.isTypeReferenceNode(node)) {
    const name = node.typeName.getText()
    if (name === 'Omit' && node.typeArguments?.length === 2) {
      // `Omit<Result, 'lease'>`: walk the base type without the keys the reply type removes.
      const removed = new Set([
        ...omitted,
        ...(node.typeArguments[1].getText().match(/'([^']+)'/g) ?? []).map((q) => q.slice(1, -1))
      ])
      collect(node.typeArguments[0], decls, where, new Set(seen), out, removed)
      return
    }
    const decl = decls.get(name)
    if (decl && !seen.has(name)) {
      seen.add(name)
      collect(decl, decls, `${where} -> ${name}`, seen, out, omitted)
    }
    node.typeArguments?.forEach((arg) => collect(arg, decls, where, seen, out, omitted))
    return
  }
  if (ts.isPropertySignature(node) && node.name) {
    const name = node.name.getText().replace(/['"]/g, '')
    if (CREDENTIAL_NAME.test(name) && !omitted.has(name)) {
      const owner = where.split('->').pop()!.trim().replace(/\(\)$/, '')
      out.push({ where, id: `${owner}.${name}`, type: node.type?.getText() ?? 'unknown' })
    }
  }
  ts.forEachChild(node, (child) => collect(child, decls, where, seen, out, omitted))
}

describe('G20 (b): no preload reply type carries a credential value', () => {
  const decls = sharedDeclarations()
  const preloadFiles = readdirSync(__dirname)
    .filter((n) => /\.ts$/.test(n) && !/\.test\.ts$/.test(n) && !/\.d\.ts$/.test(n))
    .map((n) => join(__dirname, n))

  it('finds the preload surface it is meant to check', () => {
    const api = preloadFiles.flatMap((file) => {
      const found: string[] = []
      const visit = (node: ts.Node): void => {
        if (ts.isPropertyAssignment(node) && ts.isArrowFunction(node.initializer) && node.initializer.type)
          found.push(node.name.getText())
        ts.forEachChild(node, visit)
      }
      visit(parse(file))
      return found
    })
    expect(api.length).toBeGreaterThan(150)
    expect(api).toContain('setApiKey')
    expect(api).toContain('memberLicenseStatus')
  })

  it('has only boolean flags or reviewed display values under credential-shaped names', () => {
    const findings: Finding[] = []
    for (const file of preloadFiles) {
      const visit = (node: ts.Node): void => {
        if (ts.isPropertyAssignment(node) && ts.isArrowFunction(node.initializer) && node.initializer.type) {
          const seen = new Set<string>()
          collect(node.initializer.type, decls, `${node.name.getText()}()`, seen, findings)
        }
        ts.forEachChild(node, visit)
      }
      visit(parse(file))
    }
    const harmless = (f: Finding): boolean => /^(boolean|number|number \| null)$/.test(f.type.trim())
    const unreviewed = findings.filter((f) => !Object.hasOwn(REVIEWED, f.id) && !harmless(f))
    expect(
      unreviewed.map((f) => `${f.where}: ${f.id}: ${f.type}`),
      'A reply type has a credential-shaped property that is not a flag or a number. Make it one, or review it into REVIEWED.'
    ).toEqual([])
  })
})
