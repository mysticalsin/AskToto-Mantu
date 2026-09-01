# Dust Connect

Settings → Dust CLI. One consent. Installed = connected. Overlay, Island, onboarding, Aria, and pack stay frozen.

Tony (Mac, 1 Sep 2026, 5:05pm ET): Connect said Connected, then macOS asked for the password three times, and the row still said the Dust CLI was not installed. That pair is a fail.

## Contract

1. **Connect is one sequence.** Settings Connect (or Set up Dust) runs install → login → session import under **one** consent session. It is not three privileged spawns (Electron helper, managed npm prefix / `sudo npm i -g`, `dust login`, then a separate keychain import).
2. **One OS prompt.**
   - macOS: at most one Keychain / osascript / authorization dialog for the whole sequence. Three `security find-generic-password` processes (access_token, workspace_sid, region) is the bug.
   - Windows: at most one UAC. Credential Manager reads do not prompt. `npm i -g` into a system prefix is forbidden on this path (that is a second elevation). Managed install writes under userData.
3. **Same binary.** Detect uses the binary Connect just installed, in this order: `userData/managed-cli/dust` → `~/.hermes/bin/dust` (`.cmd` / `.exe` on Windows) → PATH. A PATH-only `dust` miss after a managed install is a bug.
4. **Live in one refresh.** After Connect succeeds, status is `installed` and `live` together. `isDustReady` (key + workspace + agent) and the row detect (`resolveDustBin`) must agree. Fake Connected is a fail.
5. **Honest copy.** The row cannot say Connected and "Dust CLI is not yet installed" in the same state. Missing binary → not connected. Connected → installed + live, plus the workspace name.
6. **Mantu.** After login, if the signed-in list includes a workspace named Mantu, that is the workspace. Do not leave the picker on a random other workspace.
7. **Dead binary.** A managed `@dust-tt/dust-cli` that cannot start because a runtime dep is missing (`diff` on 0.4.6, or keytar without a real Node) is not installed. Pin a known-good tarball (0.4.5) and ensure `diff` is present after unpack. Do not mark live on a crash-on-import CLI.

## Privilege inventory (must stay at 1)

| Step | Must not do | Does |
| --- | --- | --- |
| Install | `sudo npm i -g`, Windows UAC to a global prefix, a second helper | Tarball into `userData/managed-cli/dust`. No elevation. |
| Login | A second Terminal / osascript / UAC | Browser Dust consent (native OAuth) or an already-present CLI session. Not an OS password. |
| Import | Three Keychain reads, three CredRead processes | One batched secret-store spawn per consent session. |

`countDustPrivilegeSpawns` is 1 for the install+login+import sequence in the mock. Windows Quality covers the same counter (UAC + CredRead + npm-global) even without a GUI box.

## Status

```ts
type DustConnectStatus = {
  installed: boolean // resolveDustBin found the Connect binary
  live: boolean      // session present (keychain/CredMan or Métis-persisted CLI/OAuth session)
  workspaceId?: string
  workspaceName?: string
}
```

`dustRowCopy(status)` is the only row string. Tests lock: `connected && !installed` cannot emit "not yet installed" next to Connected; after success the copy is installed + live.

## Out of scope

Overlay Hide/Island, onboarding music, Goldberg Aria, pack / EXE / DMG. Devon merges this slice only after Mac proof. READY TO MERGE: no.
