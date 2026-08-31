# Visual C++ redistributable (Windows Dust CLI)

`@dust-tt/dust-cli` loads `keytar`, a native addon. Official Node's win-x64 zip is usually enough.
If keytar still fails to load, Set up Dust runs `vc_redist.x64.exe /quiet /norestart` from this folder.

Populate with `node scripts/fetch-managed-node.mjs win` before packaging. Do not ask the user to install VC++ themselves.
