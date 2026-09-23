/** Overview-only layout. Loaded after the shared card and volume rules. */
export const OVERVIEW_CSS = `
[data-overview-kpis] {
  grid-template-columns: repeat(6, minmax(0, 1fr));
}
[data-overview-kpis] > .kpi:nth-child(-n+3) { grid-column: span 2; }
[data-overview-kpis] > .kpi:nth-child(n+4) { grid-column: span 3; }
[data-overview-kpis] .n { overflow-wrap: anywhere; font-size: clamp(22px, 2.4vw, 32px); }
.ov-pair {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px; align-items: start;
}
.ov-pair > .card { min-width: 0; }
.geo-map-card { padding-bottom: 12px; }
.geo-map-card .corner-map-svg {
  width: 100%; height: auto; aspect-ratio: 520 / 300;
  margin: 4px 0 0; border-radius: var(--radius-control);
  background: var(--map-ocean);
}
.works-path {
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px; margin: 8px 0 16px; padding: 0; list-style: none;
  counter-reset: setup-step;
}
.works-path > li {
  min-width: 0; padding: 12px; border: 1px solid var(--hair);
  border-radius: var(--radius-control); background: var(--surface-2);
  counter-increment: setup-step;
}
.works-path > li::before {
  content: counter(setup-step, decimal-leading-zero);
  display: inline-block; margin-bottom: 8px;
  color: var(--accent-text); font: 600 11px var(--mono);
}
.works-path b, .works-path span, .works-path small { display: block; }
.works-path b { color: var(--ink); font-size: 13px; }
.works-path span, .works-path small { margin-top: 4px; color: var(--ink2); font-size: 11px; }
.works-path small { color: var(--ink3); }
.overview-events-link { margin-top: 10px; }
.vol-head {
  display: grid; grid-template-columns: minmax(0, 1fr) 56px 64px;
  gap: 8px; padding: 2px 8px 5px;
  color: var(--ink3); font: 600 10px var(--font-body);
}
.vol-head > :nth-child(n+2) { text-align: right; }
.vol-row { grid-template-columns: minmax(0, 1fr) 56px 64px; }
.vol-row > .vol-bar { position: absolute; }
.vol-row > span:first-of-type {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.vol-row > span:nth-of-type(n+2) { text-align: right; }
[data-overview-people] { overflow-x: auto; }
[data-overview-people] .people-row {
  min-width: 720px; display: grid;
  grid-template-columns: 56px minmax(130px, 1.3fr) minmax(150px, 1.5fr) 100px 90px 80px;
  gap: 12px; align-items: center; padding: 8px 0;
  border-top: 1px solid var(--hair); font-size: 12px;
}
[data-overview-people] .people-row > * { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 760px) {
  [data-overview-kpis] { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  [data-overview-kpis] > .kpi:nth-child(n) { grid-column: auto; }
  .ov-pair { grid-template-columns: 1fr; }
  .works-path { grid-template-columns: 1fr; }
}
@media (max-width: 560px) {
  [data-overview-kpis] { grid-template-columns: 1fr; }
}
`
