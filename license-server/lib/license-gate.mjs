// Server-side surface for the two client-side compile-time switches that gate the license flow:
// `LICENSE_ENFORCEMENT` (App.tsx) and `LICENSE_UI_ENABLED` (Settings.tsx). This module does NOT
// flip those switches — that is a later renderer-phase change, deliberately out of scope here (see
// license-server/README.md's licensing section). What this DOES do is give an operator a single,
// server-driven place to declare the intended state of both switches so a managed-config fetch (or
// a future ActLicense onboarding step) can read one small JSON blob instead of two independent env
// vars that could silently disagree.
//
// The plan's own Phase-4 sequencing note is blunt about this: "flipping both switches activates
// its `else` branches" and a one-and-off flip "bricks the app (gate on, form hidden)". So this
// module enforces the invariant server-side too: if an operator sets LICENSE_ENFORCEMENT without
// also explicitly setting LICENSE_UI_ENABLED to the same value, we do NOT serve a drifted pair.
// Instead we fail CLOSED (both false) and flag the drift, so a misconfigured server can never tell
// a client "enforce, but don't show the UI" (a bricked app) or "show the UI, but don't enforce" (a
// gate that does nothing — the exact MQA-068 drift class the plan calls out).
function boolEnv(raw) {
  if (raw === undefined || raw === '') return undefined;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no') return false;
  return undefined;
}

// Resolves the intended { licenseEnforcement, licenseUiEnabled } pair from environment variables.
//
//  - Neither set            -> both false (today's shipped default; matches App.tsx/Settings.tsx).
//  - Both set, agreeing     -> that value, for both.
//  - Only one set           -> the unset one mirrors the set one (one knob, not two, is the
//                               supported path for turning the gate on).
//  - Both set, disagreeing  -> drift: fail closed (both false) and report `drift: true` so the
//                               operator sees it immediately rather than shipping an inconsistent
//                               config no client should ever be handed.
//  - Either set to a value that isn't a recognized boolean -> treated as unset (never crashes on a
//    typo'd env var; a misconfiguration degrades to the safe "off" default, not a 500).
export function resolveLicenseGateConfig(env = process.env) {
  const enforcementRaw = boolEnv(env.LICENSE_ENFORCEMENT);
  const uiRaw = boolEnv(env.LICENSE_UI_ENABLED);

  if (enforcementRaw === undefined && uiRaw === undefined) {
    return { licenseEnforcement: false, licenseUiEnabled: false, drift: false };
  }
  if (enforcementRaw === undefined) {
    return { licenseEnforcement: uiRaw, licenseUiEnabled: uiRaw, drift: false };
  }
  if (uiRaw === undefined) {
    return { licenseEnforcement: enforcementRaw, licenseUiEnabled: enforcementRaw, drift: false };
  }
  if (enforcementRaw === uiRaw) {
    return { licenseEnforcement: enforcementRaw, licenseUiEnabled: uiRaw, drift: false };
  }
  return { licenseEnforcement: false, licenseUiEnabled: false, drift: true };
}
