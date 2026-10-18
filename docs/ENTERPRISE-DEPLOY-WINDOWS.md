# Windows deployment evidence requirements

No deployment is approved by this document. Verify this source version's actual managed configuration paths, implemented policy keys, installer/native-helper payloads, permissions and update channel. Keep credentials and tenant details private.

MQA-068: `LICENSE_ENFORCEMENT = false` and `LICENSE_UI_ENABLED = false`; the device license gate is compiled off. A setting or separately deployed service does not activate these compiled-out paths. Do not advertise activation, seats or revocation as installed-app controls.

## Local-model source inputs

The Qwen3.5 0.8B default is bundled with its GGUF/projector pair (763,759,712 bytes).
Optional Qwen3.5 4B requires explicit selection and a first-use download (3,584,533,344 bytes)
into the profile. Local AI is off by default and existing selections are preserved; hardware capacity
does not automatically select a larger model. Model downloads use commit-pinned upstream revisions
and byte-size/SHA-256 checks to validate the payload. The compact default is available offline on supported hardware; optional
4B offline use requires pre-placing verified files. A corrupt packaged default requires installer repair.
These source contracts do not qualify any historical release bytes or rewritten source.

Verify installation, existing-profile encrypted data preservation, recovery, rollback and lifecycle behavior on supported hardware. Signing status and unsigned manual installation are distinct acceptance tracks.

The source-defined Windows machine policy path is `%ProgramData%\Métis\managed-config.json`; verify trusted administrator ownership and only implemented keys.
