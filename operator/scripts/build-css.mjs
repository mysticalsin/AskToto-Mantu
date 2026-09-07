#!/usr/bin/env node
// operator/scripts/build-css.mjs
//
// SPIKE for plan section 9b2: compiles the Operator console stylesheet at
// build time with the Tailwind v4 JS compiler API -- no PostCSS, no Vite,
// no CLI -- from the reference "Shoey" globals.css plus the class-name
// candidates scanned out of the render/client source tree.
//
// Usage:
//   node operator/scripts/build-css.mjs [globs...] [--extra <file>] [--out <path>] [--reference <path>]
//
// Defaults:
//   globs:      operator/src/render/**/*.ts  operator/client/**/*.ts
//   --out:      $TMPDIR/tailwind-spike.css
//   --reference operator/src/spa/reference.css if it exists in the repo,
//               else the WebsiteCloner globals.css this was ported from.

import { readFileSync, writeFileSync, existsSync, globSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'tailwindcss';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPERATOR_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(OPERATOR_ROOT, '..');

const FALLBACK_REFERENCE =
  '/Users/tony/Library/CloudStorage/OneDrive-MantuGroup/Documents/Chief of Staff/Apps Source/WebsiteCloner/src/app/globals.css';

const DEFAULT_GLOBS = ['operator/src/render/**/*.ts', 'operator/client/**/*.ts'];

// -- CLI args ----------------------------------------------------------

function parseArgs(argv) {
  const globs = [];
  const extras = [];
  let out = null;
  let reference = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--extra') {
      extras.push(argv[++i]);
    } else if (arg === '--out') {
      out = argv[++i];
    } else if (arg === '--reference') {
      reference = argv[++i];
    } else if (!arg.startsWith('--')) {
      globs.push(arg);
    }
  }
  return {
    globs: globs.length > 0 ? globs : DEFAULT_GLOBS,
    extras,
    out: out ?? path.join(process.env.TMPDIR ?? '/tmp', 'tailwind-spike.css'),
    reference: reference ?? defaultReferencePath(),
  };
}

function defaultReferencePath() {
  const committed = path.join(OPERATOR_ROOT, 'src', 'spa', 'reference.css');
  return existsSync(committed) ? committed : FALLBACK_REFERENCE;
}

// -- Candidate scanning --------------------------------------------------
// Per spec: pull every quoted string literal out of the source, split each
// on whitespace, keep tokens that look like class names. This is
// intentionally coarse -- Tailwind silently ignores any token that doesn't
// match a real utility, so over-collecting is harmless. It also means an
// arbitrary-value selector containing `=`, `'` or `&` (e.g.
// `[&_a[data-status='active']]:bg-def-200`) will NOT survive the token
// regex below and must be added by hand until the regex is widened -- see
// the report for the concrete examples this spike hit.
const STRING_LITERAL_RE = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
const CLASS_TOKEN_RE = /^[a-zA-Z0-9:\[\]/().%#_!-]+$/;

function scanCandidates(sourceText) {
  const found = new Set();
  let match;
  STRING_LITERAL_RE.lastIndex = 0;
  while ((match = STRING_LITERAL_RE.exec(sourceText))) {
    const literal = match[2];
    for (const token of literal.split(/\s+/)) {
      if (token && CLASS_TOKEN_RE.test(token)) {
        found.add(token);
      }
    }
  }
  return found;
}

function collectCandidates(globs, extraFiles) {
  const candidates = new Set();
  for (const pattern of globs) {
    const files = globSync(pattern, { cwd: REPO_ROOT });
    for (const rel of files) {
      const text = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      for (const token of scanCandidates(text)) candidates.add(token);
    }
  }
  for (const file of extraFiles) {
    // An --extra file is already a list of class names (one or more per
    // line), not source code, so it is tokenized directly rather than run
    // through the quoted-string-literal scanner above.
    const text = readFileSync(path.resolve(file), 'utf8');
    for (const token of text.split(/\s+/)) {
      if (token && CLASS_TOKEN_RE.test(token)) candidates.add(token);
    }
  }
  return [...candidates].sort();
}

// -- CSS transform ---------------------------------------------------------
// tw-animate-css and shadcn/tailwind.css are both dropped; the handful of
// animation utilities the reference actually uses (animate-ping,
// animate-pulse, animate-in, fade-in, slide-in-from-top-1, duration-500)
// are reimplemented inline as @utility blocks. animate-ping/animate-pulse
// already exist in Tailwind's core default theme with identical keyframes,
// so redefining them here is redundant but harmless and keeps this block
// self-contained if the core ones are ever removed/renamed upstream.
const ANIMATE_BLOCK = `
/* Inline replacement for tw-animate-css (subset actually used by the reference). */
@keyframes tw-spike-enter {
  from {
    opacity: var(--tw-enter-opacity, 1);
    transform: translate3d(var(--tw-enter-translate-x, 0), var(--tw-enter-translate-y, 0), 0)
      scale3d(var(--tw-enter-scale, 1), var(--tw-enter-scale, 1), var(--tw-enter-scale, 1));
  }
}
@keyframes tw-spike-ping {
  75%, 100% {
    transform: scale(2);
    opacity: 0;
  }
}
@keyframes tw-spike-pulse {
  50% {
    opacity: 0.5;
  }
}
@utility animate-in {
  --tw-enter-opacity: initial;
  --tw-enter-translate-x: initial;
  --tw-enter-translate-y: initial;
  --tw-enter-scale: initial;
  animation-name: tw-spike-enter;
  animation-duration: 150ms;
  animation-timing-function: ease;
}
@utility fade-in {
  --tw-enter-opacity: 0;
}
@utility slide-in-from-top-1 {
  --tw-enter-translate-y: calc(var(--spacing) * -1);
}
@utility duration-500 {
  animation-duration: 500ms;
  transition-duration: 500ms;
}
@utility animate-ping {
  animation: tw-spike-ping 1s cubic-bezier(0, 0, 0.2, 1) infinite;
}
@utility animate-pulse {
  animation: tw-spike-pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}
`;

function transformReferenceCss(source) {
  let css = source;

  if (!css.includes('@import "tailwindcss";')) {
    throw new Error('reference css does not contain @import "tailwindcss"; -- check the source file');
  }

  // Drop the animation/shadcn imports, splice in the inline replacement in
  // their place so declaration order (imports first) is preserved.
  css = css.replace(/@import "tw-animate-css";\s*\n/, '');
  css = css.replace(/@import "shadcn\/tailwind\.css";\s*\n/, ANIMATE_BLOCK + '\n');

  // The reference only toggles dark mode via a `.dark` ancestor class. The
  // Operator shell also needs `[data-theme="dark"]` to work (system/light/
  // dark tri-state stored as a data attribute, see artifact/theme
  // conventions used elsewhere in this repo). Tailwind v4 lets one
  // @custom-variant carry multiple selectors comma-separated, so `dark:`
  // utilities fire under *either* ancestor rather than only the first one
  // that was declared -- two separate `@custom-variant dark (...)`
  // statements would just have the second silently replace the first.
  css = css.replace(
    '@custom-variant dark (&:is(.dark *));',
    '@custom-variant dark (&:is(.dark *), &:is([data-theme="dark"] *));',
  );

  return css;
}

// -- Tailwind compile --------------------------------------------------

async function resolveTailwindPkgDir() {
  const pkgJsonUrl = import.meta.resolve('tailwindcss/package.json');
  return path.dirname(fileURLToPath(pkgJsonUrl));
}

function makeLoadStylesheet(tailwindPkgDir, referenceDir) {
  return async function loadStylesheet(id, base) {
    // The tailwindcss package's own entry and its (version-dependent) internal
    // imports -- 4.3.1's index.css happens to inline theme/preflight/utilities
    // already, but resolve them anyway so this keeps working if a future
    // tailwindcss version splits them back into separate @import statements.
    if (id === 'tailwindcss' || id === 'tailwindcss/index.css') {
      return readCss(path.join(tailwindPkgDir, 'index.css'));
    }
    if (id === 'tailwindcss/theme.css') return readCss(path.join(tailwindPkgDir, 'theme.css'));
    if (id === 'tailwindcss/preflight.css') return readCss(path.join(tailwindPkgDir, 'preflight.css'));
    if (id === 'tailwindcss/utilities.css') return readCss(path.join(tailwindPkgDir, 'utilities.css'));

    // Relative imports from within the tailwindcss package itself (e.g. its
    // index.css importing "./theme.css" in versions that split it out).
    if (id.startsWith('./') || id.startsWith('../')) {
      const resolved = path.resolve(base, id);
      return readCss(resolved);
    }

    throw new Error(`build-css: cannot resolve stylesheet import "${id}" from "${base}"`);
  };

  function readCss(absPath) {
    return {
      path: absPath,
      base: path.dirname(absPath),
      content: readFileSync(absPath, 'utf8'),
    };
  }
}

async function main() {
  const { globs, extras, out, reference } = parseArgs(process.argv.slice(2));

  const referenceSource = readFileSync(reference, 'utf8');
  const css = transformReferenceCss(referenceSource);

  const tailwindPkgDir = await resolveTailwindPkgDir();
  const loadStylesheet = makeLoadStylesheet(tailwindPkgDir, path.dirname(reference));

  const { build } = await compile(css, {
    base: path.dirname(reference),
    loadStylesheet,
  });

  const candidates = collectCandidates(globs, extras);
  const output = build(candidates);

  writeFileSync(out, output, 'utf8');

  const bytes = Buffer.byteLength(output, 'utf8');
  console.log(`build-css: reference=${path.relative(REPO_ROOT, reference) || reference}`);
  console.log(`build-css: scanned ${candidates.length} candidates from ${globs.length} glob(s) + ${extras.length} extra file(s)`);
  console.log(`build-css: wrote ${bytes} bytes to ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
