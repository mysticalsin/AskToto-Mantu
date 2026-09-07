# operator/src/render

Isomorphic render layer (plan D2). Each section gets a pure `render<Section>(payload, ctx) -> string`
function here, called by the Worker for first paint (`ui.ts`) and by the browser client
(`operator/client/`) for live re-render after a poll. `index.ts` currently exports only the
shared `RenderCtx` type and the `esc()` escaping helper; later tasks add one file per section.
