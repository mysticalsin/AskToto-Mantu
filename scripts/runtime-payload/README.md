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
oversized trees and files that change between inventory and archive creation.
It writes normalized owner, group, timestamp and permission fields so an
extractor never restores arbitrary archived permissions. Executable intent is
recorded as a boolean in the inventory.

`fetch-trusted-root.mjs` uses the pinned `@sigstore/tuf` client and its embedded
official bootstrap root to retrieve the official Sigstore `trusted_root.json`
TUF target. The Actions workflow retains the raw root and a source/lock/run
receipt for independent review. A fetched target is not silently added to the
app's trust policy: the catalog remains empty until the reviewed snapshot and
actual promoted immutable runtime assets are incorporated.

Candidate archive construction and native inference remain separate evidence.
The publisher does not mark an artifact production-ready merely because it was
built or attested.
