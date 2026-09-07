/**
 * A small route table so feature modules can register a handler without editing `index.ts`'s dispatch
 * chain. `handleRequest` still owns auth, HMAC, CSRF and logging; `auth` on a route is documentation of
 * what the caller already checked before `matchRoute` runs; the registry does not enforce it itself, so a
 * route is only ever reachable from the surface `handleRequest` calls it from.
 */

export type RouteAuth = 'admin' | 'hmac' | 'public'

export interface RouteMatch {
  params: Record<string, string>
}

export interface RouteDef<Ctx> {
  method: string
  pattern: RegExp | string
  auth: RouteAuth
  handler: (request: Request, ctx: Ctx, match: RouteMatch) => Promise<Response> | Response
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const routes: RouteDef<any>[] = []

/** Register a route. Registration order matters only among patterns that could both match the same
 *  pathname (an exact string checked before a broader regex); `matchRoute` returns the first match. */
export function defineRoute<Ctx>(def: RouteDef<Ctx>): RouteDef<Ctx> {
  routes.push(def)
  return def
}

/** Test-only: drop every registered route so a suite can rebuild the table from a clean slate. */
export function clearRoutes(): void {
  routes.length = 0
}

function matchPattern(pattern: RegExp | string, pathname: string): RouteMatch | null {
  if (typeof pattern === 'string') {
    return pattern === pathname ? { params: {} } : null
  }
  const m = pattern.exec(pathname)
  if (!m) return null
  return { params: { ...(m.groups ?? {}) } }
}

export async function matchRoute<Ctx>(request: Request, ctx: Ctx): Promise<Response | null> {
  const pathname = new URL(request.url).pathname
  for (const route of routes) {
    if (route.method !== request.method) continue
    const match = matchPattern(route.pattern, pathname)
    if (!match) continue
    return route.handler(request, ctx as Ctx, match)
  }
  return null
}
