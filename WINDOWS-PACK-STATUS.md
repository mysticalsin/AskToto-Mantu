# Windows pack — 1.8.9 E2E (LAUNCH-GATED)

## Verdict

**Native `windows-latest` pack passed `check-packaged-launch.mjs`.**

```text
[check:launch] window titles : ["Métis"]
[check:launch] OK — the packaged app started and showed its window
```

CI run: https://github.com/mysticalsin/AskToto-Mantu/actions/runs/34395276130

## Deliverables (draft release — replaced)

**Draft:** `v1.8.9-unsigned-win`  
https://github.com/mysticalsin/AskToto-Mantu/releases/tag/untagged-6e070d36677981a755e7

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `Metis-Setup-1.8.9.exe` | 819775359 | `dfb1de767791db62a8fae802847a7209d4a3ff3c73641e9ba096ed9b8ccab90b` |
| `Metis-Portable-1.8.9.exe` | 819422213 | `3ad32c9f4ef80d27772bcb3432cc543795924d86861248e0338ae2cf05772ecb` |

## History of this draft

1. First Linux cross-pack → DOA `cachedDataRejected` (host `.jsc`).
2. Linux plain-main rebuild → main loaded under Wine (`app.started`) but not launch-gated on Windows.
3. **This upload** → built + launch-gated on real Windows Server 2025.

## After install on your PC

Métis is **tray-first** (`skipTaskbar`). It may not show a taskbar button.

1. Uninstall any build that showed the bytecode Error dialog.
2. Install this Setup (or run Portable).
3. Check the system tray (near the clock / hidden icons).
4. Expect toast: “Métis is running”.
5. `%APPDATA%\asktoto\logs\audit.log` should contain `app.started`.

Branch: `cursor/windows-pack-latest-8ca3`.
