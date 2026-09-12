# Métis release readiness — 12 September 2026

## Decision

**HOLD: not ready for a final public release.** Source integration, automated checks,
native packaging and physical acceptance are different gates. A passing test count
does not establish transcript accuracy, trusted installer signatures or a successful
licensed meeting workflow.

The hardening source initially landed on `main` at
`0da2d80042e87f5fa671efc32b570fcebced5366`. The package version is `1.8.10`.
The follow-up diagnostic and test-isolation fixes below must pass fresh cloud checks
before integration. Run-linked evidence remains scoped to its listed revision,
not automatically to a later branch tip. No `v1.8.10` tag, public release or
replacement installer delivery is claimed by this document.

## Acceptance checklist

- [x] Merge the reviewed hardening source into `main` and read the remote SHA back.
- [x] Preserve one shared Métis source and Mac/Windows packaging configuration.
- [x] Regression-test fresh RAM-based transcription defaults and preservation of
  existing choices: at most 8 GiB selects Parakeet; higher RAM selects Whisper.
- [x] Fix licence activation/readiness, managed screenshot relay, funded automatic
  import recap and Intelligence indexing at source level (MQA-293–297,301,304).
- [x] Deploy the gated Operator update and verify the exact deployment plus health
  and negative-authentication smokes. Runtime version: `6d38d3b3`.
- [ ] Complete a real positive licence-only Ask, screenshot, automatic recap and
  background indexing workflow in the final installed app. A heartbeat is not proof.
- [x] Fix the identified idle-animation and overlay-hover defects with regressions
  (MQA-298,299,305).
- [ ] Measure comparable physical idle/load and responsiveness before and after;
  finish final-app flash/stutter and sustained meeting tests on both platforms.
- [x] Physically verify the Spotlight Ref button and its setup recovery on the
  source QA app; retain its regression coverage.
- [ ] Finish the authenticated Dust login/reference workflow on final Mac/Windows
  installations. CLI version/help/readiness checks alone are insufficient.
- [x] Fix imported audio segmentation and duration (MQA-309,310); physically replay
  the same 28.8395-second synthetic clip and confirm the amount and 0:29 duration.
- [x] Preserve known speaker names and reject ambiguous name matches/enrolment
  (MQA-307,308); distinguish unknown people from audio-channel counts (MQA-312).
- [ ] Validate automatic multi-speaker segmentation, overlap, identity and
  transcript readability with reviewed, representative meeting recordings.
- [x] Preserve all recap sections and translated inline text, and prevent invalid
  mode-name crashes (MQA-324,325,329).
- [x] Preserve the transcript/indexing and reject malformed local recaps without
  claiming completion, crediting a summary or silently using cloud AI (MQA-327).
- [ ] Resolve compact local recap semantic quality (MQA-321). Both frozen native
  comparisons failed; no runtime/model/prompt upgrade was accepted.
- [x] Include the exact existing optional compact model and projector in both
  platform resource sets; enforce size/hash/read-only bundle checks (MQA-319).
- [ ] Prove the complete fresh-profile offline text/vision workflow in both final
  packaged apps, including acceptable local output quality (MQA-319).
- [ ] Pass fresh source CI and both native package jobs on the final reviewed SHA.
- [ ] Validate a trusted Windows signing identity and final publisher/timestamp
  signature. The actual identity currently fails chain trust (MQA-332).
- [ ] Configure Apple Developer ID/notarization, then implement and verify the
  signed Mac update route. Both current Darwin guards in `src/main/updater.ts`
  return unconditionally, including for a future properly signed build; providing
  Apple credentials alone will not enable automatic updates.
- [ ] Publish one verified release through `mysticalsin/Metis-Releases`, checking
  all ten required assets, including the separate `Metis-Native` ZIP, and matching
  update metadata before latest.
- [ ] Deliver verified installers to the user-designated Apps folder; only then
  remove superseded standard Métis installers, preserving unrelated/custom apps.

## Version-bound verification evidence

| Evidence | Result | Boundary |
| --- | --- | --- |
| [Feature source CI 34722023822](https://github.com/mysticalsin/AskToto-Mantu/actions/runs/34722023822), `0da2d800` | PASS: Windows 5,896/15 skipped; Ubuntu 5,893/19 skipped; proxy 28 and Operator 925 per platform; dedicated Operator scripts 137; types, build, security and SBOM | Package jobs correctly skipped on a feature push. |
| Local full chain at `0da2d800` | PASS: root 5,895/17 skipped; proxy 28; Operator 925; scripts 137; Node/web types | Existing test-type baseline is 26, not zero. Native skips are not physical passes. |
| [Main CI 34722305054](https://github.com/mysticalsin/AskToto-Mantu/actions/runs/34722305054), same `0da2d800` | FAIL: two Windows audit-chain assertions; 5,894 other root tests passed/15 skipped. Ubuntu, Operator and security passed. | Both package jobs skipped. MQA-331 tracks deterministic diagnosis and repair; an unexplained retry is not acceptance. |
| [Windows identity preflight 34722312817](https://github.com/mysticalsin/AskToto-Mantu/actions/runs/34722312817), `0da2d800` | FAIL: `CHAIN_UNTRUSTED` after the revision guard and 66 credential-free Windows tests passed | Leaf identity checks passed. No certificate fields or secret values logged. This does not establish the trust cause or a usable installer signature. |
| [Earlier native package run 34718151583](https://github.com/mysticalsin/AskToto-Mantu/actions/runs/34718151583), `0f2e8eda` | PASS: both native package, payload/hash, metadata and clean-launch gates; Windows Whisper and Parakeet each executed without fallback | Earlier verification artifacts, not the final source or trusted release installers. |
| Live Operator | Exact health version `6d38d3b3`, healthy D1/schema; current UI shows a recent licensed Mac heartbeat; visible-menu Overview navigation verified | The dashboard showed zero minutes saved/no recaps ingested. Positive managed Ask, screenshots and time-saved accounting still need a real workflow. |
| Physical availability | Mac locked; Windows device not exposed by the current connected-project inventory | Do not bypass unlock, reinstate a revoked seat, or replace hands-on evidence with cloud builds. |

The freshly checked public stable/latest release is `v1.6.6` with Windows-only
assets. `v1.8.7` is a prerelease and `v1.8.9` is a Mac-only draft. Neither source nor
release repository has a published `v1.8.10` release at this checkpoint. Existing
draft/prerelease assets are not replacements for one verified cross-platform latest.

### Local AI quality boundary

Sixteen frozen synthetic cases exercised the actual import-recap/provider/native
runtime chain at the production temperature and unchanged compact model/profile.
Both b9957 and b10829 scored **0/16**; every output was captured and the owned native
processes were reaped. The candidate is not an accepted upgrade.

The structural safeguard rejects all 16 baseline responses and 13 of 16 candidate
responses. The other three still fail semantic checks. Format validation therefore
cannot be described as grounded summary validation. The synthetic single-trial
diagnostic is not a representative accuracy estimate or a production latency SLO.

### Package-size boundary

An independent bounded ZIP-directory read of the earlier successful cloud artifacts
confirmed individual sizes below the unchanged 1.9 GiB cap:

| Artifact at `0f2e8eda` | Bytes |
| --- | ---: |
| Mac DMG | 1,817,284,101 |
| Mac ZIP | 1,816,483,695 |
| Windows Setup EXE | 1,523,128,392 |
| Windows Portable EXE | 1,522,775,225 |

This inventory did not download/hash the whole artifact and does not prove publisher
signatures. Production dependency/secret gates, strict installer verification and
physical permission/capture tests remain mandatory. Client binaries cannot be made
impossible to reverse engineer; the security boundary is server-held secrets,
authorization, tamper resistance and verified updates, not obscurity.

## Issue tracking and remaining decisions

The [bug ledger](BUG-LEDGER.md) is the authoritative numbered registry. New failures
remain open until their specified evidence is obtained. No historical QA document
or previous release's pass is silently carried forward.

Two narrowly scoped follow-up fixes are independently reviewed and source-tested:

- **MQA-331, `34185b0e`:** both file-mutating audit tests now own unique temporary
  roots. A deterministic two-process test reproduced the exact 3-to-139 failure.
  Two simultaneous 13-test runs then passed while an independent writer retained
  all 789 records with a verified chain. Production logger, verifier, scheduling
  and existing security assertions are unchanged.
- **MQA-330, `5ae70032`:** the preflight reconstructs bounded, sorted, unique fixed
  chain-status names from validated versioned numeric facts. Contradictory
  categories and malformed/secret-bearing reports fail closed. The final
  dependency-free suite passes 153 tests with one Windows-only skip; independent
  review repeated it and 11 additional controls. This does not resolve MQA-332.

The ledger now tracks 332 issues: 326 source fixes with named regression tests,
four open issues and two other recorded dispositions. That count is not a claim
of complete physical QA or enterprise certification. Fresh cloud source, native
packaging and actual identity execution remain required for the follow-up tip.

External dependencies include usable signing identities, unlocked/reconnected test
devices and a reviewed representative meeting corpus. A materially different local
AI model/download or extractive-notes contract requires an explicit product choice;
do not silently substitute it to make this checklist green.
