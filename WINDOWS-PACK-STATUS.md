# Windows pack — 1.8.9 (FIXED)

Built on this Linux cloud agent via electron-builder cross-pack + Wine NSIS.

## Critical: first upload was DOA

The first draft upload died on Windows launch with:

```text
Error: Invalid or incompatible cached data (cachedDataRejected)
at Module._extensions..jsc (...\bytecode-loader.cjs)
```

**Cause:** `npm run build` on Linux compiled V8 bytecode (`.jsc`) with the Linux Electron.
That blob was packaged into the Windows app; Windows Electron rejected it — same DOA class
as MQA-207/240 (mac universal) and historical Windows 1.2.0 / 1.5.3.

**Fix:** rebuild with `ASKTOTO_PLAIN_MAIN=1` so main ships plain JS (`electron.vite.config.ts`).
Packaged asar now has `out/main/index.js` + `whisper-asr-host.js` and **no** `.jsc`.

## Deliverables (GitHub draft release — re-uploaded)

**Draft release:** `v1.8.9-unsigned-win`  
https://github.com/mysticalsin/AskToto-Mantu/releases/tag/untagged-7ba8cd20144c96a6b185

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `Metis-Setup-1.8.9.exe` | 974514359 | `1532abc38b90db4010213c01db171e41a699134f4275717498dd53856a861a6b` |
| `Metis-Portable-1.8.9.exe` | 974160740 | `83bc0d8b23f1a7dc72a388ce952262b49acc03111defb48dde6ae4297c1bd245` |

Also uploaded: `latest.yml`, `Metis-Setup-1.8.9.exe.blockmap`.

## What was tested here

- `ASKTOTO_PLAIN_MAIN=1 npm run build` → ~1.2MB `out/main/index.js`, no `.jsc`, no `bytecode-loader`
- Packaged asar lists only plain `out/main/*.js` (no bytecode)
- `check:packaged-runtime` OK (post-sign) for win-unpacked
- PE/NSIS validation via electron-builder success
- **Not launched:** this host is Linux; true launch proof requires Windows reinstall

## How it was rebuilt

```text
rm -rf out
ASKTOTO_PLAIN_MAIN=1 npm run build
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder \
  --config electron-builder.win.yml --win nsis portable --x64
```

Branch: `cursor/windows-pack-latest-8ca3`.
