# Runtime payload publisher

`create-payload.mjs` builds a deterministic USTAR archive compressed with the
workflow runner's locked Node/zlib toolchain. It accepts only an Actions run,
requires the checked-out source/workflow/run/attempt and lock digest to match
the metadata, rejects cross-target executable payloads, and emits a sorted
file inventory plus archive and inventory SHA-256 values. Metadata is a closed
object; every upstream source and license receipt is required, and each license
notice must match a file inside the payload.

Payload trees contain only regular files. The builder rejects symlinks,
hardlinks, special files, unsafe/non-ASCII paths, case-fold collisions,
Windows device names and trailing-dot components, oversized trees and files
that change between inventory and archive creation. It opens regular files
without following the final link, holds the descriptor while hashing and
archiving, checks file identity and timestamps after reads, caps reads at the
recorded length, and bounds directory entries, metadata input and inventory
output.
It writes normalized owner, group, timestamp and permission fields so an
extractor never restores arbitrary archived permissions. Executable intent is
recorded as a boolean in the inventory.

The signed inventory maps the closed runtime roles to exact paths in `files`
and maps closed model IDs to an explicit relative root plus exact member paths.
Runtime artifacts require at least one entrypoint and no model rows; model
artifacts require model rows and no entrypoints. A consumer must resolve only
these authenticated paths. Feature closure can reference multiple independently
catalogued artifacts. Candidate filenames are `<artifactId>.tar.gz` and
`<artifactId>.inventory.json`; a retained DSSE bundle is named
`<artifactId>.sigstore.bundle.json`. Promoted catalog rows pin exact public
asset URLs, release asset IDs, lengths and hashes for all three files.

`fetch-trusted-root.mjs` uses the pinned `@sigstore/tuf` client and its embedded
official bootstrap root to retrieve the official Sigstore `trusted_root.json`
TUF target. The Actions workflow retains the raw root and a source/lock/run
receipt for independent review. A fetched target is not silently added to the
app's trust policy: the catalog remains empty until the reviewed snapshot and
actual promoted immutable runtime assets are incorporated.

`create-attestation-fixture.mjs` exercises the same packer with a synthetic,
explicitly non-runtime fixture. On a dedicated publisher-branch push, a second
job downloads only its archive and inventory, hashes those bytes, and asks the
pinned GitHub provenance action to attest those two subjects. That job does not
check out or execute repository or artifact contents. The retained bundle is
named `<artifactId>.sigstore.bundle.json` so the app verifier can be checked
against an actual Sigstore bundle before any production row is enabled. The
fixture's identity and notice are not a production license receipt, signer
allow-list, runtime candidate, or promotion authorization.

Candidate archive construction and native inference remain separate evidence.
The publisher does not mark an artifact production-ready merely because it was
built or attested.

`runtime-llama-candidate.yml` is a native CPU inference checkpoint for the
already-pinned llama.cpp server and Qwen 0.8B text model on macOS arm64, macOS
x64, and Windows x64. It records actual Electron runtime ABI facts from the
locked Electron executable and tests local inference before packing the runtime
files. This checkpoint intentionally says `modelIncludedInArchive: false` and
`licenseCoverageComplete: false`: it is not the full offline LLM feature
closure, has not reviewed every native dependency's license, does not qualify
Metal or vision inference, and cannot populate the production catalog. The
attestation covers the exact runtime archive and inventory; it is a candidate
provenance artifact, not authorization to promote or install it.
