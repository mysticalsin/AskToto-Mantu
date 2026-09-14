/**
 * realtime page CSS.
 */
export const REALTIME_CSS = `
.rt-map-tooltip {
  position: fixed;
  z-index: 80;
  pointer-events: none;
  max-width: 280px;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.35;
  color: #fafafa;
  background: rgba(24, 24, 27, 0.92);
  border: 1px solid rgba(255,255,255,0.12);
  box-shadow: 0 8px 24px rgba(0,0,0,0.35);
}
.rt-map-tooltip[hidden] { display: none !important; }
.rt-map { position: relative; }
`
