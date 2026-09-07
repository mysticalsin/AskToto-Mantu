#!/usr/bin/env node
/**
 * Renders a standalone motion demo page exercising every helper in operator/client/motion.ts
 * (plan 3.5, 3.5b) against real-looking chrome -- a KPI tile, a bar row, a table with FLIP
 * inserts, a flashing value, a spring-press button, a sliding drawer, a shimmer block, a
 * pulsing live dot, an SVG path draw-in, and a pointer-follow tooltip. A "Reduce motion"
 * checkbox flips `setReducedMotionOverride` live so both states are visible without touching
 * the OS setting.
 *
 * Writes /private/tmp/claude-501/operator-preview/motion-demo.html. Tokens CSS and the compiled
 * motion helpers are inlined (same in-Node esbuild-and-import technique as
 * operator/scripts/build-client.mjs's loadShoeyLandSvg() and this directory's
 * preview-tokens.mjs), so the file opens standalone -- no Worker, no dev server.
 *
 * Run: `node operator/scripts/preview-motion.mjs`.
 */
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OPERATOR_ROOT = join(__dirname, '..')
const CSS_ENTRY = join(OPERATOR_ROOT, 'src', 'spa', 'css.ts')
const MOTION_ENTRY = join(OPERATOR_ROOT, 'client', 'motion.ts')
const FONTS_DIR = join(OPERATOR_ROOT, 'public', 'fonts')
const OUT_DIR = '/private/tmp/claude-501/operator-preview'

async function loadConsoleCss() {
  const result = await build({
    entryPoints: [CSS_ENTRY],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2020',
    write: false
  })
  const tmpDir = mkdtempSync(join(tmpdir(), 'metis-operator-preview-motion-css-'))
  const tmpFile = join(tmpDir, 'css.mjs')
  try {
    writeFileSync(tmpFile, result.outputFiles[0].text)
    const mod = await import(pathToFileURL(tmpFile).href)
    if (!mod.CONSOLE_CSS || typeof mod.CONSOLE_CSS !== 'string') {
      throw new Error('preview-motion: operator/src/spa/css.ts did not export CONSOLE_CSS')
    }
    return mod.CONSOLE_CSS
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

/** Bundles operator/client/motion.ts as an IIFE that assigns every export to
 *  `window.MetisMotion`, so the demo page's inline `<script>` can call the real, compiled
 *  helpers -- not a hand-copied re-implementation. */
async function buildMotionGlobal() {
  const result = await build({
    stdin: {
      contents: `export * from ${JSON.stringify(MOTION_ENTRY)}`,
      resolveDir: OPERATOR_ROOT,
      loader: 'ts'
    },
    bundle: true,
    format: 'iife',
    target: 'es2020',
    minify: false,
    globalName: 'MetisMotion',
    write: false
  })
  return result.outputFiles[0].text
}

function makeFontsStandalone(css) {
  const fontsUrl = pathToFileURL(FONTS_DIR + '/').href
  return css.replace(/url\('\/assets\/fonts\//g, `url('${fontsUrl}`)
}

const PREVIEW_CSS = `
  .pv-page { max-width: 1100px; margin: 0 auto; padding: 32px; display: grid; gap: 28px; }
  .pv-h1 { font: 600 24px/1.2 var(--font-display); letter-spacing: -0.02em; margin: 0 0 4px; }
  .pv-h1-sub { color: var(--ink-2); font: 400 13px var(--font-body); margin: 0 0 8px; }
  .pv-controls { display: flex; align-items: center; gap: 8px; font: 600 12px var(--font-body); }
  .pv-demo-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
  .pv-demo-card { position: relative; }
  .pv-demo-card h3 { margin: 0 0 10px; font: 600 13px var(--font-body); }
  .pv-demo-card p.pv-demo-note { margin: 6px 0 0; font: 12px var(--font-mono); color: var(--ink-3); }
  .pv-kpi-numeral { font: 600 32px/1 var(--font-display); letter-spacing: -0.02em; font-feature-settings: "tnum"; font-variant-numeric: tabular-nums; }
  .pv-bars-row { display: flex; align-items: flex-end; gap: 3px; height: 64px; }
  .pv-bar { width: 6px; background: var(--data-1); border-radius: 2px 2px 0 0; }
  .pv-flip-table { width: 100%; }
  .pv-flash-value { font: 600 24px var(--font-display); }
  .pv-drawer {
    position: fixed; top: 0; right: 0; height: 100%; width: 320px; z-index: 50;
    background: var(--surface); border-left: 1px solid var(--border); box-shadow: var(--shadow);
    opacity: 0; pointer-events: none;
  }
  .pv-drawer.pv-open { opacity: 1; pointer-events: auto; }
  .pv-drawer-header {
    padding: 16px; border-bottom: 1px solid var(--border);
    background: var(--glass); backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur);
    font: 600 14px var(--font-body);
  }
  .pv-drawer-body { padding: 16px; font: 13px var(--font-body); color: var(--ink-2); }
  .pv-backdrop { position: fixed; inset: 0; background: color-mix(in srgb, black 32%, transparent); z-index: 45; opacity: 0; pointer-events: none; }
  .pv-backdrop.pv-open { opacity: 1; pointer-events: auto; }
  .pv-skeleton-block { height: 72px; border-radius: var(--radius-card); background: var(--surface-2); }
  .pv-hover-box {
    position: relative; height: 120px; border-radius: var(--radius-card); background: var(--surface-2);
    border: 1px dashed var(--border-2); display: grid; place-items: center; color: var(--ink-3); font: 12px var(--font-mono);
  }
  .pv-tooltip {
    position: fixed; top: 0; left: 0; transform: translate(-1000px, -1000px);
    background: var(--ink); color: var(--bg); font: 600 11px var(--font-mono);
    padding: 4px 8px; border-radius: 6px; pointer-events: none; z-index: 60;
  }
  .pv-path-demo { display: block; width: 100%; height: 80px; }
  .pv-live-dot { width: 8px; height: 8px; border-radius: 999px; background: var(--live); display: inline-block; }
`

const CONTENT = `
<div class="pv-page">
  <div>
    <h1 class="pv-h1">Metis Operator motion demo</h1>
    <p class="pv-h1-sub">Plan 3.5 / 3.5b -- every operator/client/motion.ts helper, live. MOTION_INTENSITY 7.</p>
    <label class="pv-controls"><input type="checkbox" id="reduce-toggle"> Reduce motion</label>
  </div>

  <div class="pv-demo-grid">

    <div class="card pv-demo-card">
      <h3>KPI count-up + delta pop</h3>
      <div class="pv-kpi-numeral" id="kpi-numeral">0</div>
      <span class="delta-chip delta-up" id="kpi-delta" style="opacity:0;">&uarr; +12.4%</span>
      <p class="pv-demo-note">countUp() then pop()</p>
    </div>

    <div class="card pv-demo-card">
      <h3>30 bars, staggered grow</h3>
      <div class="pv-bars-row" id="bars-row"></div>
      <p class="pv-demo-note">growBar() x30, 20ms stagger</p>
    </div>

    <div class="card pv-demo-card">
      <h3>Value flash every 3s</h3>
      <div class="pv-flash-value" id="flash-value">241</div>
      <p class="pv-demo-note">flash(), setInterval 3000ms</p>
    </div>

    <div class="card pv-demo-card">
      <h3>Spring press button</h3>
      <button type="button" class="primary" id="press-btn">Generate license</button>
      <p class="pv-demo-note">press() -- hold the button</p>
    </div>

    <div class="card pv-demo-card">
      <h3>Drawer slide-in</h3>
      <button type="button" id="drawer-btn">Open drawer</button>
      <p class="pv-demo-note">slideIn(), glass header</p>
    </div>

    <div class="card pv-demo-card">
      <h3>Skeleton shimmer</h3>
      <div class="pv-skeleton-block" id="shimmer-block"></div>
      <p class="pv-demo-note">shimmer(el, true)</p>
    </div>

    <div class="card pv-demo-card">
      <h3>Live dot pulse</h3>
      <span class="status-dot status-dot-live"><i class="pv-live-dot" id="beacon-dot"></i><span>Live, updated 3s ago</span></span>
      <p class="pv-demo-note">beacon(), the one infinite loop</p>
    </div>

    <div class="card pv-demo-card">
      <h3>SVG path draw-in</h3>
      <svg class="pv-path-demo" viewBox="0 0 300 80" fill="none">
        <path id="draw-path" d="M4 60 Q 40 10, 80 50 T 160 40 T 240 60 T 296 20" stroke="var(--data-1)" stroke-width="3" stroke-linecap="round"/>
      </svg>
      <p class="pv-demo-note">drawPath(), 800ms</p>
    </div>

    <div class="card pv-demo-card" style="grid-column: 1 / -1;">
      <h3>Pointer-follow tooltip</h3>
      <div class="pv-hover-box" id="hover-box">Move the pointer over this box</div>
      <p class="pv-demo-note">follow(), 60ms spring lag</p>
    </div>

    <div class="card pv-demo-card" style="grid-column: 1 / -1;">
      <h3>Table: stagger-in, "load more" appends with stagger + FLIP</h3>
      <table class="pv-flip-table">
        <thead><tr><th>Country</th><th>Seats</th><th>Asks 24h</th></tr></thead>
        <tbody id="flip-tbody"></tbody>
      </table>
      <button type="button" id="load-more-btn" style="margin-top: 10px;">Load more</button>
      <p class="pv-demo-note">staggerIn() on load, flip() on load-more</p>
    </div>

  </div>
</div>

<div class="pv-backdrop" id="pv-backdrop"></div>
<div class="pv-drawer" id="pv-drawer">
  <div class="pv-drawer-header">License details</div>
  <div class="pv-drawer-body">Duration: 30 days<br>Tier: Metis<br>Status: Active</div>
</div>
<div class="pv-tooltip" id="pv-tooltip">Canada, 18 seats</div>
`

const DEMO_SCRIPT = `
(function () {
  var M = window.MetisMotion;

  document.getElementById('reduce-toggle').addEventListener('change', function (e) {
    M.setReducedMotionOverride(e.target.checked ? true : false);
  });
  // Deterministic default regardless of the host OS/browser setting: motion on until toggled.
  M.setReducedMotionOverride(false);

  // KPI count-up + delta pop
  var kpiNumeral = document.getElementById('kpi-numeral');
  M.countUp(kpiNumeral, 1284, { duration: 800 });
  var kpiDelta = document.getElementById('kpi-delta');
  setTimeout(function () { kpiDelta.style.opacity = '1'; M.pop(kpiDelta); }, 500);

  // 30 bars, staggered grow
  var barsRow = document.getElementById('bars-row');
  var heights = [];
  for (var i = 0; i < 30; i++) heights.push(12 + Math.round(Math.random() * 48));
  heights.forEach(function (h, i) {
    var bar = document.createElement('div');
    bar.className = 'pv-bar';
    bar.style.height = h + 'px';
    barsRow.appendChild(bar);
    M.growBar(bar, 400, i * 20);
  });

  // Value flash every 3s
  var flashValue = document.getElementById('flash-value');
  var flashN = 241;
  setInterval(function () {
    flashN += Math.round(Math.random() * 9) + 1;
    flashValue.textContent = String(flashN);
    M.flash(flashValue);
  }, 3000);

  // Spring press button
  M.press(document.getElementById('press-btn'));

  // Drawer slide-in
  var drawer = document.getElementById('pv-drawer');
  var backdrop = document.getElementById('pv-backdrop');
  document.getElementById('drawer-btn').addEventListener('click', function () {
    drawer.classList.add('pv-open');
    backdrop.classList.add('pv-open');
    M.slideIn(drawer, 'right');
  });
  backdrop.addEventListener('click', function () {
    drawer.classList.remove('pv-open');
    backdrop.classList.remove('pv-open');
  });

  // Skeleton shimmer
  M.shimmer(document.getElementById('shimmer-block'), true);

  // Live dot pulse
  M.beacon(document.getElementById('beacon-dot'));

  // SVG path draw-in
  M.drawPath(document.getElementById('draw-path'), 800);

  // Pointer-follow tooltip
  var hoverBox = document.getElementById('hover-box');
  var tooltip = document.getElementById('pv-tooltip');
  hoverBox.addEventListener('pointerenter', function () { tooltip.style.opacity = '1'; });
  hoverBox.addEventListener('pointerleave', function () { tooltip.style.opacity = '0'; });
  hoverBox.addEventListener('pointermove', function (e) {
    M.follow(tooltip, e, 60);
  });
  tooltip.style.opacity = '0';
  tooltip.style.transition = 'opacity 120ms';

  // Table: stagger-in on load, load-more appends with stagger + FLIP
  var COUNTRIES = [
    ['Canada', 18, 241], ['United States', 52, 903], ['France', 6, 74], ['Germany', 3, 40],
    ['United Kingdom', 9, 128], ['Japan', 2, 19], ['Brazil', 4, 51], ['India', 7, 88],
    ['Australia', 2, 22], ['Netherlands', 3, 35], ['Spain', 2, 18], ['Sweden', 1, 9]
  ];
  var tbody = document.getElementById('flip-tbody');
  var shown = 0;
  function addRows(n) {
    for (var i = 0; i < n && shown < COUNTRIES.length; i++, shown++) {
      var row = COUNTRIES[shown];
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + row[0] + '</td><td>' + row[1] + '</td><td>' + row[2] + '</td>';
      tbody.appendChild(tr);
    }
  }
  addRows(8);
  M.staggerIn(tbody.querySelectorAll('tr'));
  document.getElementById('load-more-btn').addEventListener('click', function () {
    M.flip(tbody, function () { addRows(4); });
  });
})();
`

function renderPage(css, motionJs) {
  return `<!doctype html>
<html data-theme="light">
<head>
<meta charset="utf-8">
<title>Metis Operator motion demo</title>
<style>${css}</style>
<style>${PREVIEW_CSS}</style>
</head>
<body>
${CONTENT}
<script>${motionJs}</script>
<script>${DEMO_SCRIPT}</script>
</body>
</html>
`
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const rawCss = await loadConsoleCss()
  const css = makeFontsStandalone(rawCss)
  const motionJs = await buildMotionGlobal()
  const outPath = join(OUT_DIR, 'motion-demo.html')
  writeFileSync(outPath, renderPage(css, motionJs))
  console.log(`preview-motion: wrote ${outPath}`)
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
