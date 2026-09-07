/** Exact served statement. Regex literal: slash, caret, backslash, slash, slash. esbuild
 * (which builds the real client, see client.generated.ts) always prints double-quoted string
 * literals, hence the empty string here is `""`, not `''`. */
export const PATHNAME_STRIP_JS = 'location.pathname.replace(/^\\//, "")'

/** Real esbuild-bundled TypeScript client (operator/client/**). See
 * operator/scripts/build-client.mjs and operator/src/spa/client-bundle.contract.test.ts. */
export { CONSOLE_JS, CONSOLE_JS_BUILT_FROM } from './client.generated'
