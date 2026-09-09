# Windows pack — 1.8.9 (done)

Built on this Linux cloud agent via electron-builder cross-pack + Wine NSIS.

## Deliverables (GitHub draft release)

**Draft release:** `v1.8.9-unsigned-win`  
https://github.com/mysticalsin/AskToto-Mantu/releases/tag/untagged-4f0550912858ca5f4d86

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `Metis-Setup-1.8.9.exe` | 974977127 | `b6ceb1b4c8e11802b723f1d714003deeb8377ca246559da5d742a3cbaee4c64b` |
| `Metis-Portable-1.8.9.exe` | 872753479 | `a24b4464e8727d81cf77149d967803db9f51ec0ba1c7d43e399b73ad2267f2b7` |

Also uploaded: `latest.yml`, `Metis-Setup-1.8.9.exe.blockmap`.

## What was tested here

- `check:packaged-runtime` OK (post-sign) for win-unpacked
- PE/NSIS validation via `file(1)` — Setup is Nullsoft installer; Portable is PE GUI
- SHA-256 recorded above
- **Not launched:** this host is Linux; Metis.exe was not started (no Windows GUI/ASR gate)

## How it was built

```text
predist win assets (ffmpeg/sherpa/llama/models/managed-node) without check-build-host
npm run build:intelligence && npm run build
electron-builder --config electron-builder.win.yml --win nsis portable --x64
```

Branch: `cursor/windows-pack-latest-8ca3` (workflow + this status doc).
