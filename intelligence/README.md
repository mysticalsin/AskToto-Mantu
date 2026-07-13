# Mantu Intelligence

The read-focused analysis dashboard bundled inside Métis. It renders the meeting-intelligence
"brain" — accounts, deals, people, coaching, and stats derived from recorded meetings — in its
own Electron window (opened by `src/main/intelligence.ts`).

This is a standalone Vite + React + TypeScript workspace so the dashboard can build and iterate
independently of the main app bundle. Its data is not fetched here: the main process supplies
facts from `src/main/brain/` over guarded `brain:read` and `brain:status` IPC. The dashboard may
request the existing guarded `brain:backfill` operation, but it cannot edit entities, settings,
transcripts, credentials, or other privileged app state.

## Build

```bash
npm run build:intelligence   # from the repo root: npm ci + vite build in this folder
```

`electron-builder` ships the resulting `intelligence/dist` into the packaged app under
`Resources/intelligence` (see `extraResources` in `electron-builder.yml`).

## Develop

```bash
npm install
npm run dev      # Vite dev server for isolated UI work
```

For the full picture of how meetings become brain records, see the root `README.md` and
`src/main/brain/`.
