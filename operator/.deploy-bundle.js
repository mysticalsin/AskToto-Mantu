var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// ../src/shared/operator.ts
function badgeFromFields(read, write, uncached, forced) {
  if (forced) return forced;
  if (read === void 0 && write === void 0 && uncached === void 0) return "not-reported";
  if ((read ?? 0) > 0) return "hit";
  if ((write ?? 0) > 0) return "write";
  return "write";
}
__name(badgeFromFields, "badgeFromFields");
function cacheBadge(u) {
  if (u.cacheStatus === "n/a" || u.cacheStatus === "not-reported") return u.cacheStatus;
  return badgeFromFields(u.cacheRead, u.cacheWrite, u.cacheUncached, u.cacheStatus);
}
__name(cacheBadge, "cacheBadge");
var CACHE_PRICE_MULT = {
  anthropic5mWrite: 1.25,
  anthropic1hWrite: 2,
  anthropicRead: 0.1,
  openaiWrite: 1.25,
  openaiRead: 0.5
};
var LIST_PRICE_TABLE = [
  { test: /* @__PURE__ */ __name((m) => /claude-opus/i.test(m), "test"), inputPerMTok: 15, outputPerMTok: 75, family: "Claude Opus" },
  { test: /* @__PURE__ */ __name((m) => /claude-sonnet/i.test(m), "test"), inputPerMTok: 3, outputPerMTok: 15, family: "Claude Sonnet" },
  { test: /* @__PURE__ */ __name((m) => /claude-haiku/i.test(m), "test"), inputPerMTok: 1, outputPerMTok: 5, family: "Claude Haiku" },
  { test: /* @__PURE__ */ __name((m) => /gpt-5|o3|o4/i.test(m), "test"), inputPerMTok: 10, outputPerMTok: 30, family: "OpenAI reasoning" },
  { test: /* @__PURE__ */ __name((m) => /gpt-4o|gpt-4\.1/i.test(m), "test"), inputPerMTok: 2.5, outputPerMTok: 10, family: "GPT-4o" },
  { test: /* @__PURE__ */ __name((m) => /gpt-4/i.test(m), "test"), inputPerMTok: 10, outputPerMTok: 30, family: "GPT-4" }
];
function listPriceFor(model) {
  return LIST_PRICE_TABLE.find((row) => row.test(model)) ?? null;
}
__name(listPriceFor, "listPriceFor");
function estimateCacheCost(u, model, provider) {
  if (u.cacheStatus === "n/a" || u.cacheStatus === "not-reported") return null;
  if (u.cacheRead === void 0 && u.cacheWrite === void 0 && u.cacheUncached === void 0) return null;
  const price = listPriceFor(model);
  if (!price) return null;
  const read = u.cacheRead ?? 0;
  const write = u.cacheWrite ?? 0;
  const uncached = u.cacheUncached ?? 0;
  const out = u.outputTokens ?? 0;
  const isAnthropic = provider === "anthropic" || /claude/i.test(model);
  const writeMult = isAnthropic ? u.cacheTtl === "5m" ? CACHE_PRICE_MULT.anthropic5mWrite : CACHE_PRICE_MULT.anthropic1hWrite : CACHE_PRICE_MULT.openaiWrite;
  const readMult = isAnthropic ? CACHE_PRICE_MULT.anthropicRead : CACHE_PRICE_MULT.openaiRead;
  const inputUsd = /* @__PURE__ */ __name((tok, mult) => tok / 1e6 * price.inputPerMTok * mult, "inputUsd");
  const spend = inputUsd(uncached, 1) + inputUsd(write, writeMult) + inputUsd(read, readMult) + out / 1e6 * price.outputPerMTok;
  const fullInput = inputUsd(uncached + write + read, 1);
  const cachedInput = inputUsd(uncached, 1) + inputUsd(write, writeMult) + inputUsd(read, readMult);
  return {
    usd: spend,
    savedUsd: fullInput - cachedInput,
    label: "estimate, list price",
    family: price.family
  };
}
__name(estimateCacheCost, "estimateCacheCost");
function formatUsdEstimate(n) {
  const abs = Math.abs(n);
  if (abs > 0 && abs < 0.01) return `${n < 0 ? "-" : ""}\u2248$0.01`;
  return `\u2248$${abs.toFixed(2)}`;
}
__name(formatUsdEstimate, "formatUsdEstimate");
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p / 100 * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}
__name(percentile, "percentile");
function aggregateCacheSlice(lines) {
  const hit = [];
  const miss = [];
  const na = [];
  let read = 0;
  let write = 0;
  let uncached = 0;
  let reported = 0;
  let asks = 0;
  for (const line of lines) {
    if (line.event === "rating") continue;
    asks++;
    const badge = cacheBadge({
      cacheRead: line.cacheRead,
      cacheWrite: line.cacheWrite,
      cacheUncached: line.cacheUncached,
      cacheStatus: line.cacheStatus
    });
    if (badge === "n/a") {
      if (typeof line.ttftMs === "number") na.push(line.ttftMs);
      continue;
    }
    if (badge === "not-reported") continue;
    reported++;
    if (typeof line.cacheRead === "number") read += line.cacheRead;
    if (typeof line.cacheWrite === "number") write += line.cacheWrite;
    if (typeof line.cacheUncached === "number") uncached += line.cacheUncached;
    if (typeof line.ttftMs === "number") {
      if (badge === "hit") hit.push(line.ttftMs);
      else miss.push(line.ttftMs);
    }
  }
  const denom = read + write + uncached;
  return {
    asks,
    reported,
    hitRate: denom > 0 ? read / denom : null,
    tokensRead: read,
    tokensWrite: write,
    tokensUncached: uncached,
    ttftHitP50Ms: percentile(hit, 50),
    ttftHitP95Ms: percentile(hit, 95),
    ttftMissP50Ms: percentile(miss, 50),
    ttftMissP95Ms: percentile(miss, 95),
    ttftNaP50Ms: percentile(na, 50),
    ttftNaP95Ms: percentile(na, 95)
  };
}
__name(aggregateCacheSlice, "aggregateCacheSlice");
function sanitizeOperatorHostname(raw) {
  if (typeof raw !== "string") return null;
  const host = raw.trim().slice(0, 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(host)) return null;
  return host;
}
__name(sanitizeOperatorHostname, "sanitizeOperatorHostname");
function sanitizeOperatorSsoEmail(raw) {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase().slice(0, 120);
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email)) return null;
  return email;
}
__name(sanitizeOperatorSsoEmail, "sanitizeOperatorSsoEmail");

// src/crypto.ts
var enc = new TextEncoder();
var dec = new TextDecoder();
function bytesToB64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
__name(bytesToB64, "bytesToB64");
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
__name(b64ToBytes, "b64ToBytes");
function b64urlToBytes(b64url) {
  const pad = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = pad + "=".repeat((4 - pad.length % 4) % 4);
  return b64ToBytes(padded);
}
__name(b64urlToBytes, "b64urlToBytes");
function bytesToB64url(bytes) {
  return bytesToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
__name(bytesToB64url, "bytesToB64url");
async function sha256Hex(data) {
  const buf = typeof data === "string" ? enc.encode(data) : data;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256Hex, "sha256Hex");
function decodePromptKey(raw) {
  const trimmed = raw.trim();
  try {
    const bytes = b64ToBytes(trimmed);
    if (bytes.length === 32) return bytes;
  } catch {
  }
  throw new Error("OPERATOR_PROMPT_KEY must be 32 bytes, base64");
}
__name(decodePromptKey, "decodePromptKey");
async function encryptPrompt(plaintext, keyRaw) {
  const keyBytes = decodePromptKey(keyRaw);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext)));
  return { cipher: bytesToB64(cipher), iv: bytesToB64(iv) };
}
__name(encryptPrompt, "encryptPrompt");
async function decryptPrompt(cipher, iv, keyRaw) {
  const keyBytes = decodePromptKey(keyRaw);
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(iv) },
    key,
    b64ToBytes(cipher)
  );
  return dec.decode(plain);
}
__name(decryptPrompt, "decryptPrompt");
async function signSkillPack(payload, privateKeyPkcs8Pem) {
  const pem = privateKeyPkcs8Pem.includes("BEGIN") ? privateKeyPkcs8Pem : atob(privateKeyPkcs8Pem);
  const pkcs8 = pemToPkcs8(pem);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  const payloadB64 = bytesToB64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", key, enc.encode(payloadB64)));
  return `${payloadB64}.${bytesToB64url(sig)}`;
}
__name(signSkillPack, "signSkillPack");
function pemToPkcs8(pem) {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/\s+/g, "");
  const bytes = b64ToBytes(b64);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
__name(pemToPkcs8, "pemToPkcs8");

// ../src/shared/operator-hmac.ts
var OPERATOR_HMAC_SKEW_MS = 5 * 60 * 1e3;
var OPERATOR_HMAC_HEADERS = {
  ts: "x-metis-ts",
  nonce: "x-metis-nonce",
  device: "x-metis-device",
  sig: "x-metis-sig"
};
function ingestCanonical(ts, nonce, deviceId, bodySha256Hex) {
  return `${ts}.${nonce}.${deviceId}.${bodySha256Hex}`;
}
__name(ingestCanonical, "ingestCanonical");

// src/hmac.ts
var enc2 = new TextEncoder();
async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc2.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign"
  ]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc2.encode(message)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(hmacHex, "hmacHex");
function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
__name(timingSafeEqualHex, "timingSafeEqualHex");
async function verifyIngestHmac(request, bodyText, secret, now = Date.now(), seenNonce) {
  if (!secret) return { ok: false, status: 500, error: "ingest secret not configured" };
  const tsRaw = request.headers.get(OPERATOR_HMAC_HEADERS.ts) ?? "";
  const nonce = request.headers.get(OPERATOR_HMAC_HEADERS.nonce) ?? "";
  const deviceId = request.headers.get(OPERATOR_HMAC_HEADERS.device) ?? "";
  const sig = (request.headers.get(OPERATOR_HMAC_HEADERS.sig) ?? "").toLowerCase();
  if (!tsRaw || !nonce || !deviceId || !sig) {
    return { ok: false, status: 401, error: "missing HMAC headers" };
  }
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > OPERATOR_HMAC_SKEW_MS) {
    return { ok: false, status: 401, error: "timestamp skew" };
  }
  if (seenNonce && await seenNonce(nonce)) {
    return { ok: false, status: 401, error: "replay nonce" };
  }
  const bodyHash = await sha256Hex(bodyText);
  const expected = await hmacHex(secret, ingestCanonical(tsRaw, nonce, deviceId, bodyHash));
  if (!timingSafeEqualHex(expected, sig)) {
    return { ok: false, status: 401, error: "bad HMAC signature" };
  }
  return { ok: true, deviceId, ts, nonce };
}
__name(verifyIngestHmac, "verifyIngestHmac");

// src/access.ts
var enc3 = new TextEncoder();
var dec2 = new TextDecoder();
var ADMIN_EMAILS = ["tony.walteur@gmail.com", "twalteur@amaris.com"];
var SESSION_COOKIE = "metis_operator_session";
var SESSION_TTL_MS = 24 * 60 * 60 * 1e3;
function normalizeAdminEmail(raw) {
  return raw.trim().toLowerCase();
}
__name(normalizeAdminEmail, "normalizeAdminEmail");
function isAdminEmail(raw) {
  return ADMIN_EMAILS.includes(normalizeAdminEmail(raw));
}
__name(isAdminEmail, "isAdminEmail");
function wantsJson(request) {
  const path = new URL(request.url).pathname;
  if (path.startsWith("/v1/")) return true;
  const accept = (request.headers.get("accept") || "").toLowerCase();
  if (!accept.includes("application/json")) return false;
  if (!accept.includes("text/html")) return true;
  return accept.indexOf("application/json") < accept.indexOf("text/html");
}
__name(wantsJson, "wantsJson");
async function passwordMatches(given, secret) {
  const a = await sha256Hex(given || "\0");
  const b = await sha256Hex(secret || "\0");
  return Boolean(given) && Boolean(secret) && timingSafeEqualHex(a, b);
}
__name(passwordMatches, "passwordMatches");
async function mintSessionCookie(email, secret, now) {
  const exp = now + SESSION_TTL_MS;
  const norm = normalizeAdminEmail(email);
  const packed = bytesToB64url(enc3.encode(norm));
  const sig = await hmacHex(secret, `${norm}.${exp}`);
  const value = `${packed}.${exp}.${sig}`;
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1e3)}`;
}
__name(mintSessionCookie, "mintSessionCookie");
function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
__name(clearSessionCookie, "clearSessionCookie");
async function emailFromSessionCookie(request, secret, now) {
  if (!secret) return null;
  const raw = cookieValue(request, SESSION_COOKIE);
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  let email = "";
  try {
    email = normalizeAdminEmail(dec2.decode(b64urlToBytes(parts[0] || "")));
  } catch {
    return null;
  }
  const exp = Number(parts[1]);
  const sig = parts[2] || "";
  if (!isAdminEmail(email) || !Number.isFinite(exp) || exp <= now) return null;
  const expected = await hmacHex(secret, `${email}.${exp}`);
  if (!timingSafeEqualHex(sig, expected)) return null;
  return email;
}
__name(emailFromSessionCookie, "emailFromSessionCookie");
function cookieValue(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    return part.slice(i + 1).trim();
  }
  return null;
}
__name(cookieValue, "cookieValue");
async function adminIdentity(request, ctx, env, now = Date.now()) {
  if (ctx.access) {
    try {
      const identity = await ctx.access.getIdentity();
      const email = identity?.email?.trim().toLowerCase();
      if (email && isAdminEmail(email)) return { email };
    } catch {
    }
  }
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (jwt && env.TEAM_DOMAIN && env.POLICY_AUD) {
    const email = await verifyAccessJwt(jwt, env.TEAM_DOMAIN, env.POLICY_AUD);
    if (email && isAdminEmail(email)) return { email };
  }
  if (env.OPERATOR_ADMIN_PASSWORD) {
    const email = await emailFromSessionCookie(request, env.OPERATOR_ADMIN_PASSWORD, now);
    if (email) return { email };
  }
  return null;
}
__name(adminIdentity, "adminIdentity");
async function verifyAccessJwt(token, teamDomain, aud) {
  try {
    const url = `${teamDomain.replace(/\/$/, "")}/cdn-cgi/access/certs`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const jwks = await res.json();
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const header = JSON.parse(atob(parts[0].replace(/-/g, "+").replace(/_/g, "/")));
    const key = jwks.keys?.find((k) => k.kid === header.kid);
    if (!key) return null;
    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      key,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const sig = Uint8Array.from(
      atob(parts[2].replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0)
    );
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, sig, data);
    if (!ok) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(aud)) return null;
    return payload.email?.trim().toLowerCase() ?? null;
  } catch {
    return null;
  }
}
__name(verifyAccessJwt, "verifyAccessJwt");
function unauthorized() {
  return Response.json({ ok: false, error: "Access required" }, { status: 401 });
}
__name(unauthorized, "unauthorized");

// src/crm.ts
var CRM_STATUSES = [
  "pending",
  "in_progress",
  "in_review",
  "submitted",
  "success",
  "failed",
  "expired"
];
var CRM_FILTER_ORDER = [
  "pending",
  "failed",
  "success",
  "in_progress",
  "in_review",
  "expired",
  "submitted"
];
var CRM_STATUS_ALIAS = {
  pending: "pending",
  failed: "failed",
  success: "success",
  expired: "expired",
  submitted: "submitted",
  in_progress: "in_progress",
  "in-progress": "in_progress",
  in_review: "in_review",
  "in-review": "in_review",
  dead_letter: "expired",
  "dead-letter": "expired"
};
function asCrmStatus(raw) {
  if (typeof raw !== "string") return null;
  return CRM_STATUS_ALIAS[raw.trim().toLowerCase()] ?? null;
}
__name(asCrmStatus, "asCrmStatus");
function normalizeCrmRow(row) {
  return {
    id: row.id,
    device_id: row.device_id,
    ts: row.ts,
    status: asCrmStatus(row.status) ?? "pending",
    title: row.title,
    connector: row.connector,
    meeting_file: row.meeting_file ?? null,
    meeting_hash: row.meeting_hash ?? null,
    last_error: row.last_error ?? null,
    retry_requested: row.retry_requested === 1 ? 1 : 0,
    attempt: Number.isFinite(row.attempt) ? Math.max(0, Math.floor(row.attempt)) : 0,
    latency_ms: Number.isFinite(row.latency_ms) ? Math.max(0, Math.floor(row.latency_ms)) : 0,
    remote_id: row.remote_id ?? null,
    remote_url: row.remote_url ?? null,
    action: row.action ?? null
  };
}
__name(normalizeCrmRow, "normalizeCrmRow");

// src/redact.ts
var SECRET_KEYS = /* @__PURE__ */ new Set([
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "api_key",
  "apikey",
  "authorization",
  "bearer",
  "secret",
  "hmac",
  "signature",
  "sig",
  "password",
  "prompt_cipher",
  "prompt_iv",
  "cipher",
  "iv",
  "private_key",
  "signed",
  "operator_ingest_secret",
  "operator_prompt_key",
  "operator_skill_private_key"
]);
var TOKEN_RE = [
  /bearer\s+[a-z0-9._\-+/=]{8,}/i,
  /\bsk-[a-z0-9_-]{10,}/i,
  /\bsk-ant-[a-z0-9_-]{8,}/i,
  /\bsk-proj-[a-z0-9_-]{8,}/i,
  /\bAIza[0-9A-Za-z_-]{20,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/,
  /\b[a-f0-9]{64}\b/i,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/
];
function looksLikeSecret(value) {
  if (typeof value !== "string") return false;
  const s = value.trim();
  if (!s) return false;
  if (SECRET_KEYS.has(s.toLowerCase())) return true;
  return TOKEN_RE.some((re) => re.test(s));
}
__name(looksLikeSecret, "looksLikeSecret");
function secretKeyName(key) {
  const k = key.trim().toLowerCase().replace(/[\s-]/g, "_");
  return SECRET_KEYS.has(k) || k.endsWith("_token") || k.endsWith("_secret") || k.endsWith("_key");
}
__name(secretKeyName, "secretKeyName");
function safeChips(props) {
  if (!props) return [];
  const out = [];
  for (const [key, raw] of Object.entries(props)) {
    if (raw == null || raw === "") continue;
    if (secretKeyName(key)) continue;
    const value = String(raw).trim();
    if (!value || looksLikeSecret(value) || looksLikeSecret(key)) continue;
    out.push({ key: key.slice(0, 24), value: value.slice(0, 48) });
  }
  return out;
}
__name(safeChips, "safeChips");

// src/dashboard.ts
var ONLINE_MS = 2 * 60 * 1e3;
var HOUR = 60 * 60 * 1e3;
var DAY = 24 * HOUR;
function buckets(now, count, step) {
  const start = now - count * step;
  return Array.from({ length: count }, (_, i) => start + i * step);
}
__name(buckets, "buckets");
function countIn(pulses, start, end, kind) {
  let n = 0;
  for (const p of pulses) {
    if (p.kind === kind && p.ts >= start && p.ts < end) n++;
  }
  return n;
}
__name(countIn, "countIn");
function mix(values) {
  const m = /* @__PURE__ */ new Map();
  for (const v of values) {
    const key = v || "unknown";
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}
__name(mix, "mix");
function askLine(a) {
  return {
    ts: a.ts,
    cacheRead: a.cache_read ?? void 0,
    cacheWrite: a.cache_write ?? void 0,
    cacheUncached: a.cache_uncached ?? void 0,
    cacheStatus: a.cache_status ?? void 0,
    cacheTtl: a.cache_ttl ?? void 0,
    model: a.model ?? void 0,
    provider: a.provider ?? void 0,
    outputTokens: a.output_tokens ?? void 0,
    ttftMs: a.ttft_ms ?? void 0
  };
}
__name(askLine, "askLine");
function costForAsks(asks) {
  let usd = 0;
  let any = false;
  for (const a of asks) {
    const est = estimateCacheCost(
      {
        cacheRead: a.cache_read ?? void 0,
        cacheWrite: a.cache_write ?? void 0,
        cacheUncached: a.cache_uncached ?? void 0,
        cacheStatus: a.cache_status ?? void 0,
        cacheTtl: a.cache_ttl ?? void 0,
        outputTokens: a.output_tokens ?? void 0
      },
      a.model || "",
      a.provider || void 0
    );
    if (est) {
      any = true;
      usd += est.usd;
    }
  }
  return any ? formatUsdEstimate(usd) : null;
}
__name(costForAsks, "costForAsks");
function startOfUtcDay(now) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
__name(startOfUtcDay, "startOfUtcDay");
function crmLandingKpis(rows, now = Date.now()) {
  const dayStart = startOfUtcDay(now);
  let landedToday = 0;
  let attempted = 0;
  let failedOrDead = 0;
  let retries = 0;
  let deadLetters = 0;
  for (const row of rows) {
    if (row.status === "success" && row.ts >= dayStart) landedToday += 1;
    if (row.status !== "pending") attempted += 1;
    if (row.status === "failed" || row.status === "expired") failedOrDead += 1;
    if (row.status === "expired") deadLetters += 1;
    if (row.retry_requested === 1 || row.attempt > 1) retries += 1;
  }
  return {
    landedToday,
    failRatePct: attempted === 0 ? null : Math.round(failedOrDead / attempted * 1e3) / 10,
    retries,
    deadLetters
  };
}
__name(crmLandingKpis, "crmLandingKpis");
function crmFunnelByConnector(rows) {
  const by = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const connector = row.connector.trim() || "unknown";
    const cur = by.get(connector) ?? {
      connector,
      attempted: 0,
      submitted: 0,
      success: 0,
      failed: 0
    };
    if (row.status !== "pending") cur.attempted += 1;
    if (row.status === "submitted" || row.status === "in_review" || row.status === "success") cur.submitted += 1;
    if (row.status === "success") cur.success += 1;
    if (row.status === "failed" || row.status === "expired") cur.failed += 1;
    by.set(connector, cur);
  }
  return [...by.values()].sort((a, b) => b.attempted - a.attempted || a.connector.localeCompare(b.connector));
}
__name(crmFunnelByConnector, "crmFunnelByConnector");
function uniqueSeats(seats, since) {
  const ids = /* @__PURE__ */ new Set();
  for (const s of seats) {
    if (s.last_seen >= since) ids.add(s.device_id);
  }
  return ids.size;
}
__name(uniqueSeats, "uniqueSeats");
function displayProfile(seat) {
  return {
    hostname: seat?.hostname && !looksLikeSecret(seat.hostname) ? seat.hostname : null,
    email: seat?.sso_email && !looksLikeSecret(seat.sso_email) ? seat.sso_email : null
  };
}
__name(displayProfile, "displayProfile");
function eventFromStored(row, seatsById) {
  const seat = row.device_id ? seatsById.get(row.device_id) : void 0;
  const who = displayProfile(seat);
  return {
    id: row.id,
    ts: row.ts,
    name: looksLikeSecret(row.kind) ? "event" : row.kind,
    hostname: who.hostname,
    email: who.email || (row.actor && !looksLikeSecret(row.actor) ? row.actor : null),
    chips: safeChips({
      country: row.country,
      os: seat?.os,
      detail: row.detail
    })
  };
}
__name(eventFromStored, "eventFromStored");
function mergeEvents(stored, extra) {
  const by = /* @__PURE__ */ new Map();
  for (const e of [...stored, ...extra]) {
    if (!by.has(e.id)) by.set(e.id, e);
  }
  return [...by.values()].sort((a, b) => b.ts - a.ts).slice(0, 80);
}
__name(mergeEvents, "mergeEvents");
async function buildDashboard(store, email, now, keys = { ingestBound: false, promptBound: false, skillBound: false }) {
  const seats = await store.listSeats();
  const asks = await store.listAsks(2e3);
  const pulses = await store.listPulses(now - 7 * DAY);
  const proposals = await store.listProposals();
  const audit = await store.listAudit(80);
  const crm = await store.listCrm(200);
  const packs = await store.listPacks();
  const storedEvents = await store.listEvents(80);
  const vault = await store.listVaultMeta();
  const seatsById = new Map(seats.map((s) => [s.device_id, s]));
  const live = seats.filter((s) => now - s.last_seen < ONLINE_MS).length;
  const dau = uniqueSeats(seats, now - DAY);
  const wau = uniqueSeats(seats, now - 7 * DAY);
  const versions = new Set(seats.map((s) => s.app_version).filter(Boolean)).size;
  const pendingDiffs = proposals.filter((p) => p.status === "pending").length;
  const lastIndexAt2 = seats.reduce((acc, s) => {
    if (s.last_index_at == null) return acc;
    return acc == null ? s.last_index_at : Math.max(acc, s.last_index_at);
  }, null);
  const hourStarts = buckets(now, 24, HOUR);
  const dayStarts = buckets(now, 7, DAY);
  const hours24 = hourStarts.map((t, i) => {
    const end = i === hourStarts.length - 1 ? now + 1 : t + HOUR;
    return {
      t,
      heartbeats: countIn(pulses, t, end, "heartbeat"),
      asks: countIn(pulses, t, end, "ask")
    };
  });
  const days7 = dayStarts.map((t, i) => {
    const end = i === dayStarts.length - 1 ? now + 1 : t + DAY;
    return {
      t,
      heartbeats: countIn(pulses, t, end, "heartbeat"),
      asks: countIn(pulses, t, end, "ask")
    };
  });
  const todayAsks = asks.filter((a) => a.ts >= now - DAY);
  const weekAsks = asks.filter((a) => a.ts >= now - 7 * DAY);
  const sliceToday = aggregateCacheSlice(todayAsks.map(askLine));
  const costToday = costForAsks(todayAsks);
  const cost7d = costForAsks(weekAsks);
  const tokens = hourStarts.map((t) => {
    let read = 0;
    let write = 0;
    let uncached = 0;
    for (const a of asks) {
      if (a.ts < t || a.ts >= t + HOUR) continue;
      if (a.cache_read != null) read += a.cache_read;
      if (a.cache_write != null) write += a.cache_write;
      if (a.cache_uncached != null) uncached += a.cache_uncached;
    }
    return { t, read, write, uncached };
  });
  const tableMap = /* @__PURE__ */ new Map();
  for (const a of weekAsks) {
    const provider = a.provider || "unknown";
    const mode = a.mode || "unknown";
    const key = `${provider}\0${mode}`;
    const cur = tableMap.get(key) ?? {
      provider,
      mode,
      asks: 0,
      read: null,
      write: null,
      uncached: null,
      estimate: null,
      usd: 0,
      anyCost: false
    };
    cur.asks++;
    if (a.cache_read != null) cur.read = (cur.read ?? 0) + a.cache_read;
    if (a.cache_write != null) cur.write = (cur.write ?? 0) + a.cache_write;
    if (a.cache_uncached != null) cur.uncached = (cur.uncached ?? 0) + a.cache_uncached;
    const est = estimateCacheCost(
      {
        cacheRead: a.cache_read ?? void 0,
        cacheWrite: a.cache_write ?? void 0,
        cacheUncached: a.cache_uncached ?? void 0,
        cacheStatus: a.cache_status ?? void 0,
        cacheTtl: a.cache_ttl ?? void 0,
        outputTokens: a.output_tokens ?? void 0
      },
      a.model || "",
      a.provider || void 0
    );
    if (est) {
      cur.anyCost = true;
      cur.usd += est.usd;
    }
    tableMap.set(key, cur);
  }
  const table = [...tableMap.values()].map((r) => ({
    provider: r.provider,
    mode: r.mode,
    asks: r.asks,
    read: r.read,
    write: r.write,
    uncached: r.uncached,
    estimate: r.anyCost ? formatUsdEstimate(r.usd) : null
  }));
  const countryMap = /* @__PURE__ */ new Map();
  for (const s of seats) {
    if (!s.country) continue;
    const set = countryMap.get(s.country) ?? /* @__PURE__ */ new Set();
    set.add(s.device_id);
    countryMap.set(s.country, set);
  }
  const countries = [...countryMap.entries()].map(([iso, set]) => ({ iso, devices: set.size })).sort((a, b) => b.devices - a.devices);
  const dots = seats.filter((s) => s.lat != null && s.lon != null && s.country).map((s) => ({ lat: s.lat, lon: s.lon, city: s.city, country: s.country }));
  const heatStart = now - 17 * 7 * DAY;
  const heatmap = Array.from({ length: 17 * 7 }, () => 0);
  const bumpHeat = /* @__PURE__ */ __name((ts) => {
    if (ts < heatStart || ts > now) return;
    const day = Math.floor((ts - heatStart) / DAY);
    if (day >= 0 && day < heatmap.length) heatmap[day]++;
  }, "bumpHeat");
  for (const a of audit) bumpHeat(a.ts);
  for (const p of packs) bumpHeat(p.pushed_at);
  for (const p of proposals) {
    bumpHeat(p.created_at);
    if (p.decided_at) bumpHeat(p.decided_at);
  }
  const counts = Object.fromEntries(CRM_STATUSES.map((s) => [s, 0]));
  for (const row of crm) counts[row.status]++;
  return {
    email,
    now,
    kpis: {
      live,
      dau,
      wau,
      versions,
      cacheHit: sliceToday.hitRate == null ? null : `${Math.round(sliceToday.hitRate * 100)}%`,
      costToday,
      cost7d,
      pendingDiffs,
      lastIndexAt: lastIndexAt2,
      liveSeries: hours24.map((p) => p.heartbeats),
      dauSeries: days7.map((p) => p.heartbeats),
      costSeries: tokens.map((p) => p.read + p.write + p.uncached),
      hitSeries: hourStarts.map((t) => {
        const slice = aggregateCacheSlice(asks.filter((a) => a.ts >= t && a.ts < t + HOUR).map(askLine));
        return slice.hitRate == null ? 0 : Math.round(slice.hitRate * 100);
      })
    },
    scale: {
      hours24,
      days7,
      versions: mix(seats.map((s) => s.app_version)),
      os: mix(seats.map((s) => s.os))
    },
    cost: { tokens, table },
    change: {
      timeline: audit.map((a) => ({ ts: a.ts, actor: a.actor, action: a.action, detail: a.detail })),
      heatmap,
      adoption: mix(seats.map((s) => s.app_version))
    },
    map: {
      countries,
      dots,
      empty: countries.length === 0 && dots.length === 0
    },
    asks: asks.slice(0, 40).map((a) => ({
      id: a.id,
      ts: a.ts,
      mode: a.mode || "",
      preview: a.preview || "Ask",
      cache_status: a.cache_status || "not-reported",
      provider: a.provider || ""
    })),
    proposals: proposals.map((p) => ({
      id: p.id,
      skill_id: p.skill_id,
      from_version: p.from_version,
      status: p.status,
      rationale: p.rationale,
      diff: p.diff,
      evidence: JSON.parse(p.evidence_json || "[]"),
      created_by: p.created_by,
      created_at: p.created_at
    })),
    crm: {
      counts,
      landing: crmLandingKpis(crm, now),
      funnel: crmFunnelByConnector(crm),
      rows: crm.map((r) => ({
        id: r.id,
        status: r.status,
        title: r.title,
        connector: r.connector,
        ts: r.ts,
        error: r.last_error,
        retryRequested: r.retry_requested === 1,
        device: r.device_id.slice(0, 8),
        attempt: r.attempt,
        latencyMs: r.latency_ms,
        remoteId: r.remote_id,
        remoteUrl: r.remote_url,
        meetingHash: r.meeting_hash,
        action: r.action
      }))
    },
    events: mergeEvents(
      storedEvents.map((e) => eventFromStored(e, seatsById)),
      [
        ...asks.slice(0, 40).map((a) => {
          const who = displayProfile(seatsById.get(a.device_id));
          return {
            id: `ask-${a.id}`,
            ts: a.ts,
            name: "ask",
            hostname: who.hostname,
            email: who.email,
            chips: safeChips({
              mode: a.mode,
              provider: a.provider,
              cache: a.cache_status,
              os: seatsById.get(a.device_id)?.os
            })
          };
        }),
        ...crm.slice(0, 40).map((r) => {
          const who = displayProfile(seatsById.get(r.device_id));
          return {
            id: `crm-${r.id}`,
            ts: r.ts,
            name: "crm",
            hostname: who.hostname,
            email: who.email,
            chips: safeChips({
              status: r.status,
              connector: r.connector,
              action: r.action
            })
          };
        })
      ]
    ),
    profiles: seats.slice().sort((a, b) => b.last_seen - a.last_seen).map((s) => ({
      device: s.device_id.slice(0, 8),
      hostname: s.hostname && !looksLikeSecret(s.hostname) ? s.hostname : null,
      email: s.sso_email && !looksLikeSecret(s.sso_email) ? s.sso_email : null,
      os: s.os,
      appVersion: s.app_version,
      country: s.country,
      city: s.city,
      lastSeen: s.last_seen,
      live: now - s.last_seen < ONLINE_MS,
      license: s.license && !looksLikeSecret(s.license) ? s.license : null
    })),
    keys: {
      ingestBound: keys.ingestBound,
      promptBound: keys.promptBound,
      skillBound: keys.skillBound,
      vault: vault.map((v) => ({
        provider: looksLikeSecret(v.provider) ? "provider" : v.provider,
        label: looksLikeSecret(v.label) ? "key" : v.label,
        last4: /^\w{2,8}$/.test(v.last4) ? v.last4 : "----",
        status: v.status
      }))
    }
  };
}
__name(buildDashboard, "buildDashboard");

// src/geo.ts
var ISO = /^[A-Z]{2}$/;
var CF_SPECIAL = /* @__PURE__ */ new Set(["XX", "T1"]);
function asCountry(raw) {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  if (ISO.test(code) || CF_SPECIAL.has(code)) return code;
  return null;
}
__name(asCountry, "asCountry");
function asCity(raw) {
  if (typeof raw !== "string") return null;
  const city = raw.trim().slice(0, 80);
  return city || null;
}
__name(asCity, "asCity");
function asCoord(raw, min, max) {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return Math.round(n * 1e3) / 1e3;
}
__name(asCoord, "asCoord");
function geoFromRequest(request) {
  const cf = request.cf;
  if (!cf || typeof cf !== "object") {
    return { country: null, city: null, lat: null, lon: null };
  }
  return {
    country: asCountry(cf.country),
    city: asCity(cf.city),
    lat: asCoord(cf.latitude, -90, 90),
    lon: asCoord(cf.longitude, -180, 180)
  };
}
__name(geoFromRequest, "geoFromRequest");

// src/d1.ts
var NONCE_TTL_MS = 10 * 60 * 1e3;
var PULSE_TTL_MS = 8 * 24 * 60 * 60 * 1e3;
function d1Store(db) {
  return {
    async takeNonce(nonce, ts) {
      const existing = await db.prepare("SELECT nonce FROM nonces WHERE nonce = ?").bind(nonce).first();
      if (existing) return true;
      await db.prepare("INSERT INTO nonces (nonce, ts) VALUES (?, ?)").bind(nonce, ts).run();
      await db.prepare("DELETE FROM nonces WHERE ts < ?").bind(ts - NONCE_TTL_MS).run();
      return false;
    },
    async hitRate(deviceId, now, windowMs, max) {
      const cur = await db.prepare("SELECT window_start, count FROM rate_limits WHERE device_id = ?").bind(deviceId).first();
      if (!cur || now - cur.window_start > windowMs) {
        await db.prepare(
          "INSERT INTO rate_limits (device_id, window_start, count) VALUES (?, ?, 1) ON CONFLICT(device_id) DO UPDATE SET window_start = ?, count = 1"
        ).bind(deviceId, now, now).run();
        return false;
      }
      const next = cur.count + 1;
      await db.prepare("UPDATE rate_limits SET count = ? WHERE device_id = ?").bind(next, deviceId).run();
      return next > max;
    },
    async upsertSeat(row) {
      const prev = await db.prepare("SELECT first_seen FROM seats WHERE device_id = ?").bind(row.device_id).first();
      await db.prepare(
        `INSERT INTO seats (device_id, seat_hash, os, app_version, first_seen, last_seen, country, city, lat, lon, last_index_at, hostname, sso_email, license)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(device_id) DO UPDATE SET
             seat_hash = excluded.seat_hash,
             os = excluded.os,
             app_version = excluded.app_version,
             last_seen = excluded.last_seen,
             country = COALESCE(excluded.country, seats.country),
             city = COALESCE(excluded.city, seats.city),
             lat = COALESCE(excluded.lat, seats.lat),
             lon = COALESCE(excluded.lon, seats.lon),
             last_index_at = COALESCE(excluded.last_index_at, seats.last_index_at),
             hostname = COALESCE(excluded.hostname, seats.hostname),
             sso_email = COALESCE(excluded.sso_email, seats.sso_email),
             license = COALESCE(excluded.license, seats.license)`
      ).bind(
        row.device_id,
        row.seat_hash,
        row.os,
        row.app_version,
        prev?.first_seen ?? row.first_seen,
        row.last_seen,
        row.country,
        row.city,
        row.lat,
        row.lon,
        row.last_index_at,
        row.hostname,
        row.sso_email,
        row.license
      ).run();
    },
    async insertAsk(row) {
      await db.prepare(
        `INSERT OR REPLACE INTO asks (
            id, device_id, ts, mode, skill_id, skill_version, provider, model,
            ttft_ms, total_ms, input_tokens, output_tokens, cache_read, cache_write,
            cache_uncached, cache_status, cache_ttl, outcome, rating, prompt_cipher, prompt_iv, preview
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        row.id,
        row.device_id,
        row.ts,
        row.mode,
        row.skill_id,
        row.skill_version,
        row.provider,
        row.model,
        row.ttft_ms,
        row.total_ms,
        row.input_tokens,
        row.output_tokens,
        row.cache_read,
        row.cache_write,
        row.cache_uncached,
        row.cache_status,
        row.cache_ttl,
        row.outcome,
        row.rating,
        row.prompt_cipher,
        row.prompt_iv,
        row.preview
      ).run();
    },
    async updateAskRating(id, rating) {
      const outcome = rating === "down" ? "thumbs-down" : null;
      if (outcome) {
        await db.prepare("UPDATE asks SET rating = ?, outcome = ? WHERE id = ?").bind(rating, outcome, id).run();
      } else {
        await db.prepare("UPDATE asks SET rating = ? WHERE id = ?").bind(rating, id).run();
      }
    },
    async listAsks(limit) {
      const r = await db.prepare("SELECT * FROM asks ORDER BY ts DESC LIMIT ?").bind(limit).all();
      return r.results;
    },
    async getAsk(id) {
      return await db.prepare("SELECT * FROM asks WHERE id = ?").bind(id).first() ?? null;
    },
    async listSeats() {
      const r = await db.prepare("SELECT * FROM seats").all();
      return r.results.map((s) => ({
        ...s,
        hostname: s.hostname ?? null,
        sso_email: s.sso_email ?? null,
        license: s.license ?? null
      }));
    },
    async insertPulse(row) {
      await db.prepare("INSERT OR REPLACE INTO pulses (id, device_id, ts, kind, country, city) VALUES (?, ?, ?, ?, ?, ?)").bind(row.id, row.device_id, row.ts, row.kind, row.country, row.city).run();
      await db.prepare("DELETE FROM pulses WHERE ts < ?").bind(row.ts - PULSE_TTL_MS).run();
    },
    async listPulses(since) {
      const r = await db.prepare("SELECT * FROM pulses WHERE ts >= ? ORDER BY ts ASC").bind(since).all();
      return r.results;
    },
    async listProposals() {
      const r = await db.prepare("SELECT * FROM proposals ORDER BY created_at DESC").all();
      return r.results;
    },
    async getProposal(id) {
      return await db.prepare("SELECT * FROM proposals WHERE id = ?").bind(id).first() ?? null;
    },
    async putProposal(row) {
      await db.prepare(
        `INSERT OR REPLACE INTO proposals (
            id, skill_id, from_version, evidence_json, diff, rationale, status,
            created_by, created_at, decided_at, reject_reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        row.id,
        row.skill_id,
        row.from_version,
        row.evidence_json,
        row.diff,
        row.rationale,
        row.status,
        row.created_by,
        row.created_at,
        row.decided_at,
        row.reject_reason
      ).run();
    },
    async listPacks() {
      const r = await db.prepare("SELECT * FROM packs").all();
      return r.results;
    },
    async latestPacks() {
      const r = await db.prepare("SELECT * FROM packs ORDER BY pushed_at DESC").all();
      const by = /* @__PURE__ */ new Map();
      for (const p of r.results) {
        if (!by.has(p.skill_id)) by.set(p.skill_id, p);
      }
      return [...by.values()];
    },
    async putPack(row) {
      await db.prepare(
        `INSERT OR REPLACE INTO packs (
            id, skill_id, version, sha256, body, signed, pushed_at, pushed_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(row.id, row.skill_id, row.version, row.sha256, row.body, row.signed, row.pushed_at, row.pushed_by).run();
    },
    async upsertCrm(row) {
      await db.prepare(
        `INSERT INTO crm_sends (
             id, device_id, ts, status, title, connector, meeting_file, meeting_hash,
             last_error, retry_requested, attempt, latency_ms, remote_id, remote_url, action
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             ts = excluded.ts,
             status = excluded.status,
             title = excluded.title,
             connector = excluded.connector,
             meeting_file = excluded.meeting_file,
             meeting_hash = excluded.meeting_hash,
             last_error = excluded.last_error,
             retry_requested = excluded.retry_requested,
             attempt = excluded.attempt,
             latency_ms = excluded.latency_ms,
             remote_id = excluded.remote_id,
             remote_url = excluded.remote_url,
             action = excluded.action`
      ).bind(
        row.id,
        row.device_id,
        row.ts,
        row.status,
        row.title,
        row.connector,
        row.meeting_file,
        row.meeting_hash,
        row.last_error,
        row.retry_requested,
        row.attempt,
        row.latency_ms,
        row.remote_id,
        row.remote_url,
        row.action
      ).run();
    },
    async getCrm(id) {
      const row = await db.prepare("SELECT * FROM crm_sends WHERE id = ?").bind(id).first();
      return row ? normalizeCrmRow(row) : null;
    },
    async listCrm(limit) {
      const r = await db.prepare("SELECT * FROM crm_sends ORDER BY ts DESC LIMIT ?").bind(limit).all();
      return r.results.map(normalizeCrmRow);
    },
    async listCrmRetries(deviceId) {
      const r = await db.prepare(
        `SELECT * FROM crm_sends
           WHERE device_id = ? AND retry_requested = 1 AND status IN ('pending', 'failed', 'expired')`
      ).bind(deviceId).all();
      return r.results.map(normalizeCrmRow);
    },
    async audit(id, ts, actor, action, askId, detail) {
      await db.prepare("INSERT INTO audit (id, ts, actor, action, ask_id, detail) VALUES (?, ?, ?, ?, ?, ?)").bind(id, ts, actor, action, askId, detail).run();
    },
    async listAudit(limit) {
      const r = await db.prepare("SELECT ts, actor, action, ask_id, detail FROM audit ORDER BY ts DESC LIMIT ?").bind(limit).all();
      return r.results;
    },
    async insertEvent(row) {
      await db.prepare(
        "INSERT OR REPLACE INTO events (id, ts, kind, actor, device_id, country, detail) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(row.id, row.ts, row.kind, row.actor, row.device_id, row.country, row.detail).run();
    },
    async listEvents(limit) {
      const r = await db.prepare("SELECT id, ts, kind, actor, device_id, country, detail FROM events ORDER BY ts DESC LIMIT ?").bind(limit).all();
      return r.results;
    },
    async listVaultMeta() {
      const r = await db.prepare("SELECT provider, label, last4, status FROM vault_keys ORDER BY created_at DESC").all();
      return r.results;
    }
  };
}
__name(d1Store, "d1Store");

// src/store.ts
var PULSE_TTL_MS2 = 8 * 24 * 60 * 60 * 1e3;
function memoryStore() {
  const nonces = /* @__PURE__ */ new Set();
  const rates = /* @__PURE__ */ new Map();
  const seats = /* @__PURE__ */ new Map();
  const asks = /* @__PURE__ */ new Map();
  const pulses = [];
  const proposals = /* @__PURE__ */ new Map();
  const packs = /* @__PURE__ */ new Map();
  const crm = /* @__PURE__ */ new Map();
  const audits = [];
  const events = /* @__PURE__ */ new Map();
  const vault = [];
  return {
    async takeNonce(nonce) {
      if (nonces.has(nonce)) return true;
      nonces.add(nonce);
      return false;
    },
    async hitRate(deviceId, now, windowMs, max) {
      const cur = rates.get(deviceId);
      if (!cur || now - cur.window_start > windowMs) {
        rates.set(deviceId, { window_start: now, count: 1 });
        return false;
      }
      cur.count++;
      return cur.count > max;
    },
    async upsertSeat(row) {
      const prev = seats.get(row.device_id);
      seats.set(row.device_id, {
        ...row,
        first_seen: prev?.first_seen ?? row.first_seen,
        country: row.country ?? prev?.country ?? null,
        city: row.city ?? prev?.city ?? null,
        lat: row.lat ?? prev?.lat ?? null,
        lon: row.lon ?? prev?.lon ?? null,
        last_index_at: row.last_index_at ?? prev?.last_index_at ?? null,
        hostname: row.hostname ?? prev?.hostname ?? null,
        sso_email: row.sso_email ?? prev?.sso_email ?? null,
        license: row.license ?? prev?.license ?? null
      });
    },
    async insertAsk(row) {
      asks.set(row.id, row);
    },
    async updateAskRating(id, rating) {
      const row = asks.get(id);
      if (row) {
        row.rating = rating;
        if (rating === "down") row.outcome = "thumbs-down";
      }
    },
    async listAsks(limit) {
      return [...asks.values()].sort((a, b) => b.ts - a.ts).slice(0, limit);
    },
    async getAsk(id) {
      return asks.get(id) ?? null;
    },
    async listSeats() {
      return [...seats.values()];
    },
    async insertPulse(row) {
      pulses.push(row);
      const cut = row.ts - PULSE_TTL_MS2;
      for (let i = pulses.length - 1; i >= 0; i--) {
        if (pulses[i].ts < cut) pulses.splice(i, 1);
      }
    },
    async listPulses(since) {
      return pulses.filter((p) => p.ts >= since);
    },
    async listProposals() {
      return [...proposals.values()].sort((a, b) => b.created_at - a.created_at);
    },
    async getProposal(id) {
      return proposals.get(id) ?? null;
    },
    async putProposal(row) {
      proposals.set(row.id, row);
    },
    async listPacks() {
      return [...packs.values()];
    },
    async latestPacks() {
      const by = /* @__PURE__ */ new Map();
      for (const p of packs.values()) {
        const cur = by.get(p.skill_id);
        if (!cur || p.pushed_at > cur.pushed_at) by.set(p.skill_id, p);
      }
      return [...by.values()];
    },
    async putPack(row) {
      packs.set(row.id, row);
    },
    async upsertCrm(row) {
      crm.set(row.id, row);
    },
    async getCrm(id) {
      return crm.get(id) ?? null;
    },
    async listCrm(limit) {
      return [...crm.values()].sort((a, b) => b.ts - a.ts).slice(0, limit);
    },
    async listCrmRetries(deviceId) {
      return [...crm.values()].filter(
        (r) => r.device_id === deviceId && r.retry_requested === 1 && (r.status === "pending" || r.status === "failed" || r.status === "expired")
      );
    },
    async audit(id, ts, actor, action, askId, detail) {
      audits.push({ id, ts, actor, action, ask_id: askId, detail });
    },
    async listAudit(limit) {
      return audits.slice(-limit).reverse();
    },
    async insertEvent(row) {
      events.set(row.id, row);
    },
    async listEvents(limit) {
      return [...events.values()].sort((a, b) => b.ts - a.ts).slice(0, limit);
    },
    async listVaultMeta() {
      return [...vault];
    }
  };
}
__name(memoryStore, "memoryStore");

// src/world-paths.ts
var WORLD_PATHS = { "FJ": "M995 299L996 299L994 301L992 299L995 299ZM0 295L0 296L998 297L996 296L998 295L0 295Z", "TZ": "M594 253L605 259L609 263L608 268L610 270L609 272L610 275L612 279L607 281L604 282L601 283L596 282L594 277L591 276L588 274L585 273L582 268L582 265L583 262L585 260L585 258L585 257L586 255L585 253L594 253Z", "CA": "M159 114L153 111L146 109L145 105L141 101L137 98L139 95L131 90L127 86L124 84L118 86L114 83L108 82L108 56L118 58L123 57L131 57L139 55L143 56L146 55L154 55L158 57L163 56L173 58L180 59L180 61L192 62L198 63L198 60L203 59L207 60L213 61L222 62L226 60L233 60L235 61L238 58L232 55L236 50L242 52L243 56L248 60L256 59L257 63L262 59L266 56L274 58L272 61L274 64L265 66L261 67L257 70L250 72L248 75L241 78L237 83L241 87L244 91L253 92L257 94L264 96L271 97L272 102L278 108L282 104L278 98L286 95L287 91L282 87L284 81L285 76L293 77L297 77L302 80L307 83L310 87L316 87L321 82L326 88L328 94L335 97L341 98L344 101L345 105L341 107L333 110L323 110L316 110L310 114L302 120L309 116L319 113L319 116L321 122L329 123L332 121L330 124L322 127L316 129L321 124L314 125L312 119L309 119L306 120L304 124L302 124L296 125L291 126L288 128L284 129L280 129L281 131L277 132L271 134L269 134L269 133L271 131L271 127L268 123L268 122L266 121L265 121L264 120L260 118L255 116L251 117L245 116L240 115L237 114L236 113L230 114L211 114L194 114L178 114L167 114L159 114ZM267 77L269 75L273 75L273 76L269 77L267 77ZM278 48L275 45L283 45L288 48L282 48L278 48ZM277 78L278 77L279 77L280 77L279 79L278 79L277 78ZM240 42L238 43L234 43L231 42L233 41L237 40L239 41L240 42ZM239 35L238 35L233 35L232 34L238 34L240 34L239 35ZM231 31L234 33L227 33L226 31L231 31ZM255 43L243 42L242 39L233 38L231 36L240 37L248 38L250 39L256 40L264 40L275 40L278 42L272 43L261 43L255 43ZM191 33L195 33L194 34L189 35L185 34L187 33L191 33ZM192 31L195 32L192 32L187 32L190 31L192 31ZM346 107L342 112L346 111L347 113L351 113L353 115L354 118L351 121L350 118L346 120L346 118L341 118L335 117L335 115L341 109L345 107L346 107ZM267 69L273 71L276 72L275 74L269 72L262 75L258 73L260 70L263 68L265 68L267 69ZM281 49L290 49L294 52L302 53L311 55L309 59L320 62L328 64L322 69L315 66L311 68L317 70L320 74L316 75L313 75L316 78L303 75L300 73L292 70L284 72L284 69L295 68L295 66L297 62L292 60L288 58L283 56L279 56L264 56L254 54L254 52L249 49L254 46L260 47L264 46L276 48L281 49ZM237 44L249 45L241 48L235 50L233 46L237 44ZM159 39L169 35L177 34L175 37L167 39L159 39ZM131 100L133 103L135 105L132 103L130 100L131 100ZM207 30L220 31L223 34L214 32L211 31L207 30ZM157 115L151 114L148 112L144 111L143 109L148 110L152 111L156 114L157 115ZM162 43L173 44L179 46L169 49L165 52L157 52L151 49L156 45L162 43ZM201 39L206 39L205 42L188 43L184 42L177 42L177 38L187 38L197 40L196 37L199 38L201 39ZM204 47L209 51L214 54L219 57L216 58L210 59L202 58L190 59L184 58L177 58L176 55L184 55L182 54L172 54L177 52L168 51L173 48L183 47L188 47L195 47L199 51L199 47L204 47ZM221 48L221 45L230 45L228 47L231 51L224 52L215 49L221 48ZM204 46L208 45L210 46L207 48L203 46L204 46ZM226 37L229 40L223 42L220 40L215 38L222 37L226 37ZM233 26L238 25L243 24L252 26L258 29L258 30L248 33L239 31L241 30L233 29L233 26ZM246 23L253 22L263 20L269 21L275 19L288 19L298 19L310 19L323 20L328 21L315 23L318 24L307 26L297 29L286 30L288 31L288 33L282 35L279 36L284 37L269 38L257 38L251 36L255 34L264 35L256 32L263 31L260 29L266 27L273 26L257 26L249 24L246 23ZM291 63L286 64L287 61L291 61L291 63ZM233 57L233 59L227 58L225 56L230 56L233 57ZM321 111L322 111L325 112L328 113L328 114L327 114L323 113L321 111ZM322 119L325 121L326 122L322 121L322 119Z", "US": "M159 114L175 114L186 114L203 114L220 114L236 114L237 113L238 115L243 115L248 116L252 117L257 117L262 119L265 120L265 121L266 121L267 122L268 122L271 124L272 129L270 132L269 133L270 134L274 133L281 131L281 130L281 129L287 129L288 128L292 125L301 125L303 124L305 122L308 118L310 118L312 123L314 126L308 128L304 130L303 132L305 134L306 134L304 135L300 135L298 135L299 136L296 137L295 137L295 138L292 142L291 141L291 142L292 143L289 147L290 145L288 141L288 144L288 145L289 148L290 151L285 154L282 156L280 158L275 161L274 165L275 169L276 172L278 177L277 180L275 180L273 178L270 174L270 171L267 167L264 168L262 166L257 166L252 166L252 167L252 169L251 169L248 169L243 168L239 167L234 170L230 173L230 176L230 178L227 178L224 175L222 172L220 168L215 167L211 169L209 166L207 164L204 162L199 163L192 163L181 160L178 159L174 158L171 156L169 155L166 154L165 152L160 146L158 144L156 140L155 136L154 131L156 126L155 120L154 116L158 117L160 118L159 114ZM68 194L69 195L70 196L68 197L67 197L66 195L67 195L67 194L68 194ZM67 192L66 193L65 192L67 192ZM65 191L64 191L63 191L65 191ZM61 190L62 191L60 190L61 190ZM57 188L57 189L56 189L57 188ZM38 82L40 83L40 84L38 84L37 83L35 83L38 82ZM74 89L77 90L72 92L70 90L74 89ZM108 56L108 82L114 83L118 86L124 84L127 86L131 90L139 95L137 98L133 96L129 91L125 88L117 87L109 84L100 83L91 81L89 83L84 84L79 86L79 81L82 80L76 83L74 86L69 90L65 92L60 94L55 95L49 97L42 99L45 97L51 95L55 93L60 91L62 88L61 87L58 88L56 87L52 87L50 85L49 83L43 83L41 80L40 78L43 75L47 75L51 74L53 72L53 70L49 71L46 71L38 70L33 68L43 65L45 66L49 65L43 62L37 60L43 59L47 56L53 54L61 53L69 52L73 53L77 54L84 54L95 55L101 55L108 56ZM23 73L26 73L31 74L29 75L26 74L23 74L23 73Z", "KZ": "M743 113L738 115L737 119L729 124L722 125L723 131L721 132L716 131L710 131L705 130L700 131L697 133L692 135L690 137L685 136L683 133L680 129L672 129L667 126L663 123L655 135L652 133L647 133L646 133L646 131L641 128L640 126L643 124L647 124L647 120L642 119L636 121L635 119L631 117L631 113L632 110L635 109L645 106L655 109L662 108L666 109L671 108L669 104L671 103L671 100L682 98L692 96L698 100L704 100L707 101L713 100L722 109L728 109L733 109L736 111L741 112L743 113Z", "UZ": "M655 135L663 123L667 126L672 129L680 129L683 133L685 136L690 137L692 135L697 133L696 135L700 135L699 138L696 138L696 136L692 139L688 140L689 142L688 147L685 146L681 143L676 141L672 136L668 135L667 133L661 133L659 135L655 135Z", "PG": "M892 257L902 261L905 264L910 267L908 269L911 272L915 275L917 277L919 279L917 280L914 279L909 276L906 272L900 272L898 275L895 275L892 266L892 257ZM924 260L925 262L924 262L922 260L919 258L921 258L923 259L924 260ZM920 266L917 268L914 267L912 265L916 265L917 264L919 265L921 263L923 262L923 264L921 265L920 266ZM930 265L932 267L933 269L931 268L929 264L930 265Z", "ID": "M892 257L892 275L886 272L882 273L885 270L883 265L875 262L870 261L869 260L867 258L872 257L867 256L864 254L866 252L872 252L873 258L879 256L884 255L889 257L892 257ZM847 275L847 276L843 279L843 277L847 275ZM873 269L873 267L873 266L874 265L874 266L874 267L873 269ZM827 239L828 244L831 247L826 250L824 254L823 261L819 261L816 260L811 260L808 258L806 254L803 251L803 246L805 246L809 247L812 246L816 247L820 242L822 238L827 239ZM859 258L863 261L859 259L855 259L859 258ZM852 261L851 260L850 259L853 259L853 260L852 261ZM855 244L857 246L857 249L855 251L856 252L854 247L855 244ZM841 248L847 245L846 249L841 249L834 249L836 254L843 252L841 253L838 255L840 260L842 265L840 265L838 263L838 262L836 257L834 261L833 266L832 262L831 260L831 256L833 250L836 246L841 248ZM834 278L830 277L833 276L835 277L835 278L834 278ZM837 274L841 272L837 275L833 273L837 274ZM828 273L831 274L826 275L825 273L827 272L828 273ZM801 268L807 269L813 269L818 272L818 274L813 273L807 273L802 271L796 270L793 269L798 267L801 268ZM790 253L791 257L795 259L794 266L789 264L784 260L780 256L776 249L774 245L770 241L765 236L766 235L773 238L777 241L782 244L786 248L787 252L790 253Z", "AR": "M309 396L312 400L319 402L315 403L312 402L309 396ZM340 334L338 339L338 342L338 346L341 350L342 353L335 358L327 358L327 362L326 364L320 363L320 367L323 367L321 369L319 374L315 375L312 379L318 381L313 385L309 390L309 394L310 395L300 394L299 391L296 390L298 386L299 383L301 377L302 374L301 373L300 371L301 367L301 361L303 357L302 352L304 348L306 342L304 337L306 332L308 326L309 324L310 318L314 314L316 311L321 313L325 311L331 316L337 319L340 321L340 326L345 326L348 321L351 323L349 326L344 330L340 334Z", "CL": "M309 396L312 402L313 404L309 404L306 403L299 401L293 397L299 399L304 399L307 396L309 396ZM307 299L308 303L309 307L312 314L314 314L310 318L309 324L308 326L306 332L304 337L306 342L304 348L302 352L303 357L301 361L301 367L300 371L301 373L302 374L301 377L299 383L298 386L296 390L299 391L300 394L310 395L306 396L303 400L298 399L292 395L292 392L290 385L294 380L293 377L297 373L296 367L294 370L295 361L296 356L297 353L300 344L301 336L301 330L304 321L305 309L305 301L307 299Z", "CD": "M581 262L582 267L584 270L584 273L580 274L580 277L579 283L582 284L582 287L579 285L576 284L574 283L571 281L568 281L566 280L563 281L562 281L561 276L561 273L560 270L557 269L556 270L553 271L551 272L549 272L547 270L545 266L536 267L534 267L535 266L535 264L537 264L539 263L541 264L544 261L544 258L547 253L549 251L550 249L550 245L551 242L552 238L554 236L558 238L562 239L563 237L568 236L570 236L571 235L575 236L578 238L580 238L583 237L586 240L587 244L585 246L583 248L582 252L581 255L581 256L581 259L581 262Z", "SO": "M636 218L636 219L636 224L633 228L621 224L619 222L619 220L621 219L623 221L627 220L632 219L634 218L636 218Z", "KE": "M609 263L605 259L594 253L595 249L597 245L596 240L596 237L599 235L600 238L606 240L607 240L610 240L613 238L616 239L614 252L614 256L612 257L611 260L609 263Z", "SD": "M568 227L565 225L565 223L564 220L564 218L562 216L561 215L562 213L563 211L563 208L566 207L566 194L569 189L591 189L603 192L603 195L605 199L605 202L602 203L601 209L601 212L598 216L596 220L594 223L594 224L594 222L592 220L592 216L591 217L590 218L588 221L586 223L582 222L581 223L578 224L575 223L574 223L572 221L569 223L567 226L568 227Z", "TD": "M566 196L564 206L562 210L562 212L561 214L562 215L563 218L564 219L560 221L556 225L552 225L551 227L546 229L545 228L542 229L542 227L540 225L539 222L541 222L541 220L541 216L541 213L539 211L539 206L543 200L544 193L543 192L541 186L555 190L566 196Z", "HT": "M301 195L301 198L301 199L299 199L296 199L293 199L296 199L299 198L298 196L297 195L301 195Z", "DO": "M301 200L300 198L301 197L301 195L305 195L306 196L308 197L310 198L308 199L306 199L304 199L303 199L301 201L301 200Z", "RU": "M760 25L772 26L778 31L764 30L757 27L760 25ZM786 30L793 31L792 32L776 34L781 30L784 30L786 30ZM886 39L903 40L891 42L880 41L886 39ZM912 41L919 41L915 43L911 42L906 41L907 40L912 41ZM889 46L891 45L895 45L899 46L899 47L895 47L889 46ZM625 26L634 26L636 26L643 26L638 27L635 27L629 27L625 26ZM563 99L555 99L559 97L563 98L563 99ZM649 45L655 41L670 38L684 37L691 37L680 40L662 44L654 49L660 54L649 53L643 51L646 49L651 45L649 45ZM897 101L898 106L902 114L896 117L899 122L895 122L894 117L895 112L893 106L896 101L896 99L897 101ZM863 133L863 131L865 127L866 124L872 122L874 118L870 116L864 117L859 113L854 109L852 106L847 102L840 102L834 103L835 106L831 109L827 112L821 112L818 110L810 113L804 113L800 112L794 110L788 111L784 108L778 107L772 108L770 112L763 111L759 110L752 110L744 113L741 112L736 111L733 109L728 109L722 109L713 100L707 101L704 100L698 100L692 96L682 98L671 100L671 103L669 104L671 108L666 109L662 108L655 109L645 106L635 109L632 110L631 113L631 117L635 119L636 121L632 123L632 129L635 134L633 136L630 134L627 133L624 131L622 131L614 129L611 129L604 126L604 124L605 120L609 119L606 118L610 117L610 114L611 112L606 111L602 110L598 109L595 108L596 106L591 105L589 105L588 103L587 102L591 102L588 101L587 100L586 97L583 95L581 95L577 92L576 90L576 87L578 85L578 82L586 77L583 73L582 70L581 64L579 60L582 58L589 56L601 58L614 63L611 66L594 65L597 67L597 71L603 73L601 70L610 71L610 68L619 66L624 65L623 61L628 60L627 62L629 65L634 62L649 59L649 61L654 60L663 59L670 58L668 56L680 58L692 59L689 57L687 56L685 53L692 48L702 48L700 52L702 54L705 60L698 66L702 65L706 63L707 60L705 58L707 54L708 50L709 48L709 52L711 50L721 49L724 48L728 45L741 45L742 41L751 40L759 39L769 39L780 38L783 35L795 35L797 36L800 37L815 38L816 41L806 43L807 44L814 45L817 46L830 46L842 47L848 46L857 47L857 50L865 53L872 52L882 52L889 51L890 48L918 51L936 53L944 54L947 57L956 56L966 57L974 58L973 55L988 56L0 58L14 63L16 66L23 64L25 68L21 71L17 71L11 70L8 68L3 67L0 67L0 70L996 71L995 72L998 75L998 77L985 78L978 81L973 84L962 84L958 84L953 86L950 89L953 94L949 96L945 99L940 103L936 108L933 102L933 92L936 89L945 85L955 80L953 76L945 82L935 79L931 86L920 87L916 84L904 85L886 91L880 98L884 101L889 99L893 105L890 111L885 119L880 125L875 129L869 131L864 132L863 133ZM0 51L3 51L6 52L0 53L996 53L0 51ZM593 122L596 122L597 123L601 124L598 125L593 126L590 124L593 123L593 122Z", "BS": "M281 176L282 175L284 175L284 176L281 177L281 176ZM284 175L286 176L286 178L285 178L285 176L284 175ZM283 180L284 180L285 182L285 184L284 184L283 183L282 182L283 180Z", "NO": "M542 29L547 28L560 31L551 34L548 37L538 35L537 33L529 29L538 29L542 29ZM586 57L579 58L577 55L571 58L566 59L559 57L556 58L550 60L547 61L542 66L539 71L535 72L533 78L534 83L531 87L523 88L516 87L514 78L524 74L534 67L546 60L559 55L568 53L578 52L583 55L586 57ZM576 28L564 29L555 28L548 27L561 27L571 27L576 28ZM569 34L562 35L558 34L559 34L558 33L564 32L565 33L569 34Z", "TL": "M847 275L850 273L853 273L853 274L847 276L847 275Z", "ZA": "M545 329L548 329L550 330L553 330L555 319L558 322L558 325L561 323L563 321L566 321L570 321L572 320L574 318L575 315L582 311L584 312L587 312L589 318L588 322L586 321L585 323L587 326L589 324L590 326L589 330L587 332L585 335L580 339L576 342L572 344L570 344L566 344L563 344L557 346L554 347L552 346L551 345L551 342L551 340L549 335L547 333L545 329ZM580 330L578 330L575 333L578 335L580 334L581 331L580 330Z", "LS": "M580 330L581 333L579 334L577 335L576 331L579 330L580 330Z", "MX": "M175 160L181 159L185 161L197 163L199 162L205 163L208 165L210 168L214 170L218 167L221 170L224 173L225 177L229 178L229 181L228 186L229 189L230 193L233 196L237 198L240 199L244 198L248 196L249 192L251 191L257 190L259 191L257 194L257 196L256 199L255 199L253 200L252 200L250 201L247 202L247 203L248 204L249 205L244 208L244 209L241 207L237 205L233 206L230 206L225 204L220 202L217 200L213 199L208 196L206 193L207 192L208 190L206 188L203 184L199 180L196 178L195 176L193 173L190 171L188 169L186 164L184 162L181 162L181 164L182 167L185 170L186 171L187 173L188 175L191 179L192 181L194 183L196 185L195 187L194 185L190 182L188 179L187 177L184 176L182 175L181 173L183 172L181 169L178 166L176 162L175 160Z", "UY": "M340 334L345 336L348 337L352 341L352 344L347 347L344 347L339 346L338 342L338 339L340 334Z", "BR": "M352 344L352 341L348 337L345 336L340 334L347 327L351 325L350 321L349 320L349 317L347 317L346 315L345 312L342 312L339 308L339 305L340 303L340 299L338 297L333 295L333 292L332 290L330 287L327 287L324 285L318 282L318 279L315 278L311 280L309 281L305 281L304 276L299 278L297 276L296 273L295 270L297 268L297 266L301 263L303 262L307 254L307 252L306 248L308 248L306 247L311 245L313 245L314 247L318 248L321 246L322 245L324 243L321 241L320 239L323 239L326 239L331 237L331 236L333 236L334 238L334 240L334 244L336 246L338 246L340 245L342 245L344 245L344 244L346 243L349 244L351 243L352 244L354 243L357 238L358 240L361 245L359 249L365 251L367 252L375 254L376 257L385 258L393 260L399 264L402 265L404 270L401 277L395 284L393 286L392 294L391 300L390 304L386 311L383 314L376 315L371 317L365 322L365 325L364 330L359 336L355 340L352 344Z", "BO": "M307 280L310 281L313 279L319 277L319 280L321 285L326 286L329 287L332 288L333 291L332 292L338 295L338 298L340 300L339 304L338 306L336 304L328 305L327 308L325 311L321 313L316 311L312 314L309 307L308 303L307 299L307 294L307 292L309 288L309 285L307 280Z", "PE": "M306 262L303 262L298 265L297 267L295 269L294 271L297 275L298 276L302 278L304 281L307 280L309 286L308 290L308 293L308 296L306 300L302 299L296 295L289 291L288 288L283 279L279 272L276 268L275 266L275 261L277 261L277 262L279 262L282 263L284 258L290 254L291 250L293 251L295 254L299 257L302 257L305 258L304 260L306 262Z", "CO": "M314 247L313 245L311 245L306 247L308 248L306 248L307 252L307 254L304 260L305 258L302 257L299 257L295 254L293 251L291 250L288 249L285 249L284 248L281 245L281 244L284 243L286 239L285 237L285 234L284 230L285 229L285 226L287 226L290 224L290 221L294 219L296 219L299 217L302 216L302 217L299 219L297 221L296 225L298 226L299 228L299 229L300 231L305 231L308 233L312 233L312 235L312 237L313 240L312 242L313 244L314 247Z", "PA": "M285 226L285 228L284 229L283 229L283 227L282 226L279 225L277 227L276 228L277 229L275 230L274 229L273 227L271 227L270 228L270 227L270 226L270 225L271 223L272 225L273 225L275 225L278 224L280 223L282 224L284 225L285 226Z", "CR": "M271 223L270 225L270 226L270 227L268 227L268 225L267 224L265 223L264 222L264 223L262 222L262 221L261 220L262 219L265 219L266 220L268 220L269 222L271 223Z", "NI": "M268 220L266 220L265 219L262 219L261 218L259 216L256 214L257 214L258 214L259 213L260 212L261 211L262 211L263 210L264 210L264 209L265 209L267 209L268 208L269 209L269 210L268 212L268 214L268 216L268 218L267 219L268 220Z", "HN": "M269 208L268 209L266 209L265 209L264 209L263 210L262 211L262 212L260 212L259 212L259 213L257 214L256 213L256 211L254 212L253 211L252 210L252 209L254 207L255 206L257 206L260 206L261 206L263 206L264 206L266 206L267 207L269 208Z", "SV": "M252 210L253 211L254 212L256 211L256 213L254 213L252 213L250 212L251 211L251 210L252 210Z", "GT": "M244 210L244 208L245 205L249 204L248 204L246 202L247 201L252 201L252 206L254 206L255 206L252 208L252 209L251 210L251 211L250 212L247 211L244 210Z", "BZ": "M252 201L253 200L254 199L255 199L255 200L255 201L255 203L254 205L253 206L252 203L252 201Z", "VE": "M331 236L331 237L326 239L323 239L320 239L321 241L324 243L322 245L321 246L318 248L314 247L313 243L313 241L312 239L312 235L313 233L310 233L307 233L304 230L299 230L299 229L299 227L298 225L297 223L298 220L300 218L302 218L301 220L300 223L302 225L302 222L305 218L306 216L309 218L311 221L316 220L320 222L321 220L328 220L327 222L331 224L333 226L332 228L333 230L330 231L329 233L331 236Z", "GY": "M343 245L341 245L339 246L337 246L334 245L333 242L335 239L333 237L333 235L329 233L330 231L333 230L332 228L336 228L338 231L340 232L341 236L339 237L340 241L341 242L343 245Z", "SR": "M349 244L346 243L344 244L344 245L341 242L340 241L339 237L341 236L345 234L347 233L349 236L350 240L349 242L349 244Z", "FR": "M357 238L354 243L352 244L351 243L349 244L349 241L349 238L350 234L353 235L357 238ZM517 113L522 114L521 118L519 118L517 120L518 121L519 123L519 125L521 127L518 130L509 130L505 132L501 132L495 129L497 122L492 118L487 115L496 115L497 113L505 108L507 109L510 110L513 111L516 113L517 113ZM524 132L526 131L527 133L526 135L524 134L524 133L524 132Z", "EC": "M291 250L290 254L284 258L282 263L279 262L277 262L277 261L278 257L277 257L276 255L276 253L278 249L279 247L284 248L285 249L288 249L291 250Z", "PR": "M316 199L318 199L315 200L313 199L316 199Z", "JM": "M285 199L288 200L286 200L284 200L283 199L285 199Z", "CU": "M271 186L276 186L280 188L283 188L287 191L290 192L292 193L294 194L290 195L284 195L285 193L282 192L280 190L276 189L272 188L270 187L267 188L265 189L265 188L267 187L271 186Z", "ZW": "M587 312L584 312L582 311L578 310L577 307L573 304L571 301L573 300L575 300L579 296L580 295L584 293L587 294L588 295L591 296L591 302L591 305L590 307L587 312Z", "BW": "M582 311L575 315L574 318L572 320L570 321L566 321L563 321L561 323L558 325L558 322L555 319L558 311L560 301L565 301L568 300L570 299L572 302L576 307L577 308L580 310L582 311Z", "NA": "M555 319L553 330L550 330L548 329L545 329L542 325L541 321L540 313L539 310L536 305L533 300L534 298L537 297L539 298L553 299L564 299L569 298L570 299L567 300L564 300L558 301L555 311L555 319Z", "SN": "M454 212L451 209L454 207L455 204L458 204L461 205L464 207L466 211L468 213L468 215L466 215L465 216L462 215L456 215L454 216L456 214L457 213L459 213L462 212L460 212L458 211L457 212L454 212Z", "ML": "M468 215L468 213L466 211L467 209L468 207L472 207L473 207L485 205L483 193L486 181L505 193L507 195L509 197L512 203L510 207L504 207L501 209L499 208L494 210L492 212L490 213L488 213L485 217L485 220L484 222L483 221L481 221L479 222L478 222L477 220L476 220L477 218L475 216L474 216L473 216L471 217L469 216L468 216L468 215Z", "MR": "M453 192L464 191L464 185L467 178L476 174L482 181L485 205L485 207L473 208L470 208L468 207L466 209L463 205L460 204L457 205L454 205L455 202L455 197L455 194L453 192Z", "BJ": "M507 233L504 231L504 224L503 222L502 219L504 218L506 217L508 216L510 219L510 221L509 224L508 226L507 233Z", "NE": "M541 186L543 192L544 193L543 200L539 206L539 211L541 213L539 214L539 215L536 212L532 213L530 213L526 214L522 213L519 214L515 211L511 212L510 215L508 216L506 217L503 214L501 211L501 209L504 207L510 207L512 203L516 196L533 185L539 188L541 186Z", "NG": "M507 233L508 226L509 224L510 221L510 219L510 215L511 212L515 211L519 214L522 213L526 214L530 213L532 213L536 212L539 215L540 216L540 218L537 222L536 224L534 227L533 229L531 232L528 230L526 232L524 237L520 238L516 238L514 234L510 233L507 233Z", "CM": "M540 214L542 218L543 222L541 222L539 223L542 226L543 229L541 232L540 235L540 237L542 239L544 242L544 244L542 245L536 244L534 244L531 244L527 241L525 239L524 238L524 235L526 232L529 230L533 231L534 228L535 226L537 223L538 220L540 217L539 215L540 214Z", "TG": "M502 219L503 222L504 224L504 231L503 234L502 231L502 227L501 224L500 220L502 219Z", "GH": "M500 219L501 222L501 226L501 229L502 233L499 235L495 237L492 235L492 229L492 223L492 220L498 220L500 219Z", "CI": "M478 222L479 222L481 221L483 221L484 222L486 222L488 223L490 222L493 227L491 233L492 236L489 236L484 236L479 238L479 236L479 234L477 233L477 231L477 229L477 227L478 224L477 222L478 222Z", "GN": "M462 215L465 216L466 215L468 215L469 216L470 216L472 217L473 216L475 216L476 217L476 219L477 220L477 221L477 222L478 224L477 227L477 229L475 230L474 229L473 226L472 227L471 226L470 224L469 222L466 223L465 223L463 225L461 223L460 222L459 220L459 218L461 218L462 217L462 216L462 215Z", "GW": "M454 216L456 215L462 215L462 216L461 218L460 218L458 219L455 218L455 217L454 216Z", "LR": "M477 229L477 231L477 233L479 234L479 236L478 238L472 234L468 231L469 229L472 227L473 226L474 229L475 230L477 229Z", "SL": "M463 225L465 223L466 223L469 222L470 224L471 226L472 227L469 229L468 231L465 230L464 227L463 225Z", "BF": "M485 221L486 218L488 215L489 213L491 212L494 210L497 208L499 209L501 210L503 213L506 215L505 218L503 219L500 219L498 220L492 220L492 223L489 223L487 223L485 221Z", "CF": "M576 235L573 236L570 236L569 236L565 237L563 237L560 238L556 237L553 237L551 240L548 240L544 244L544 242L542 239L540 237L540 235L541 232L545 229L546 229L550 228L553 226L553 225L558 224L562 220L564 220L565 223L565 225L568 227L570 229L573 232L576 235Z", "CG": "M551 240L550 243L549 248L549 250L549 252L546 255L544 260L542 262L539 263L538 262L536 263L534 263L531 261L532 258L535 257L536 257L540 256L540 252L540 247L537 246L536 244L542 245L544 244L548 240L551 240Z", "GA": "M531 244L534 244L536 244L537 246L540 247L540 252L540 256L536 257L535 257L532 258L531 261L526 256L525 252L526 249L527 247L531 244Z", "GQ": "M527 244L531 244L531 247L527 247L526 247L527 244Z", "ZM": "M585 273L588 274L591 276L593 279L592 282L592 286L592 289L584 293L580 295L579 296L575 300L573 300L570 299L569 298L564 299L561 295L567 286L567 284L567 281L567 280L569 281L572 283L575 282L578 284L580 287L582 284L580 283L579 280L579 275L581 273L585 273Z", "MW": "M591 276L594 277L596 282L596 288L598 289L599 294L597 297L595 293L596 291L594 290L591 288L593 285L593 280L592 277L591 276Z", "MZ": "M596 282L601 283L604 282L607 281L612 279L612 283L613 289L612 293L610 296L604 299L600 302L597 305L598 309L598 311L599 314L599 316L597 318L592 320L591 323L591 324L589 323L588 321L588 316L590 309L591 306L591 304L591 300L590 296L588 295L584 294L584 291L594 290L596 291L595 293L597 297L599 294L598 289L596 288L596 282Z", "SZ": "M589 324L587 326L585 323L586 321L588 322L589 324Z", "AO": "M536 263L535 265L534 266L534 263L536 263ZM534 267L536 267L545 266L547 270L549 272L551 272L553 271L556 270L557 269L560 270L561 273L561 276L562 281L563 281L566 280L566 283L566 285L561 286L563 297L559 300L551 298L539 298L536 297L533 298L533 294L534 290L535 286L538 283L538 280L536 277L536 275L536 271L534 267Z", "BI": "M585 257L585 258L585 260L583 262L581 259L582 258L585 257Z", "IL": "M599 159L598 160L598 162L597 163L598 164L597 167L596 162L597 161L597 158L599 158L600 158L599 159Z", "LB": "M600 158L599 158L599 156L600 154L602 155L600 158Z", "MG": "M638 285L639 288L640 292L639 294L638 294L638 297L637 300L635 307L632 316L629 320L625 320L622 318L620 313L621 309L622 308L624 304L622 301L623 297L625 295L627 294L630 292L633 289L634 288L636 285L638 285Z", "PS": "M598 163L597 162L597 161L599 160L598 163Z", "GM": "M454 212L457 211L459 212L461 212L460 213L458 212L456 213L453 213L454 212Z", "TN": "M526 166L523 160L521 157L523 154L523 149L526 146L528 148L531 147L529 150L530 153L529 156L531 158L532 160L530 162L528 164L526 166Z", "DZ": "M476 174L476 173L480 168L485 167L490 164L491 162L496 160L496 159L495 154L497 151L501 149L509 148L515 148L520 147L523 147L523 151L521 155L523 159L525 161L527 168L527 172L527 175L526 178L528 181L530 182L533 185L516 196L509 197L507 195L505 193L486 181L476 174Z", "JO": "M599 160L602 160L609 161L603 162L605 166L602 167L600 169L597 168L598 163L599 160Z", "AE": "M643 183L644 183L648 183L652 181L656 178L657 181L655 183L654 184L653 186L653 188L643 183Z", "QA": "M641 181L642 178L643 178L643 182L641 181Z", "KW": "M633 167L634 169L633 171L629 169L633 167Z", "IQ": "M609 161L614 154L615 149L618 147L622 147L624 147L628 151L627 153L628 158L633 162L633 164L635 167L631 167L624 169L612 161L609 161Z", "OM": "M653 187L654 185L656 183L655 181L658 183L661 184L664 186L666 187L665 190L664 191L661 193L660 195L660 197L657 198L656 200L654 201L652 203L649 204L647 202L653 194L653 187ZM656 179L656 178L657 177L657 178L656 179Z", "KH": "M785 216L786 210L792 210L796 210L799 212L794 218L792 220L787 220L785 216Z", "TH": "M792 210L786 210L785 216L780 215L778 213L776 220L776 224L779 227L781 231L784 233L781 234L778 232L777 231L775 228L773 228L773 225L775 220L776 214L775 212L773 208L775 205L772 201L772 198L775 195L778 193L779 196L781 199L784 200L786 200L789 199L791 204L793 209L792 210Z", "LA": "M798 211L795 211L793 209L791 204L789 199L786 200L784 200L781 199L779 196L778 193L781 190L783 191L784 188L787 192L791 195L789 196L794 201L798 206L798 211Z", "MM": "M778 193L775 195L772 198L772 201L775 205L773 208L775 212L776 214L775 220L773 220L773 217L773 212L771 205L768 204L763 206L763 202L760 196L759 195L756 190L757 189L758 187L759 183L763 181L764 178L768 174L770 173L770 171L773 173L774 176L771 180L774 183L776 186L778 190L781 189L779 192L778 193Z", "VN": "M790 221L795 220L799 216L798 211L798 206L794 201L789 196L791 195L787 192L784 188L788 187L793 185L796 187L797 189L796 193L794 197L798 204L802 208L803 218L798 221L792 226L792 222L790 221Z", "KP": "M863 132L862 133L860 134L859 137L857 138L854 140L854 141L857 143L855 144L852 145L850 145L849 145L848 145L846 144L848 143L848 141L846 140L847 137L852 134L856 135L860 132L863 132Z", "KR": "M850 145L852 145L855 144L857 143L860 148L859 153L854 154L851 153L850 148L850 145Z", "MN": "M744 113L752 110L759 110L763 111L770 112L772 108L778 107L784 108L788 111L794 110L800 112L804 113L810 113L818 110L821 112L823 114L822 117L826 118L830 117L832 120L826 120L822 123L815 126L811 125L810 128L809 129L803 132L795 133L790 134L783 132L776 132L768 131L765 127L760 125L753 124L753 120L747 116L744 113Z", "IN": "M770 171L770 173L768 174L764 178L763 181L759 183L758 187L757 189L755 184L753 185L755 183L755 180L750 180L748 178L745 178L745 181L746 183L747 186L747 190L742 190L740 194L733 199L728 203L727 205L723 206L723 212L722 217L720 221L720 224L717 227L713 225L710 219L708 215L707 209L703 200L702 193L698 192L692 189L693 187L691 182L697 180L695 176L696 172L702 170L707 164L709 160L706 157L706 153L714 154L719 155L720 158L718 159L721 164L724 167L725 171L731 174L737 176L742 177L745 176L745 173L747 174L749 176L753 176L756 174L757 173L763 169L767 168L767 171L770 171Z", "BD": "M757 189L756 190L756 191L755 188L751 187L751 189L749 189L747 189L746 184L745 182L747 180L746 177L750 178L752 180L757 181L754 183L755 186L756 184L757 189Z", "BT": "M755 173L756 175L751 175L747 175L749 172L752 172L755 173Z", "NP": "M745 173L745 176L742 177L737 176L731 174L725 171L724 167L726 165L731 168L734 170L738 172L745 173Z", "PK": "M716 151L710 154L705 155L707 159L707 162L704 167L699 172L693 175L695 179L697 182L689 184L687 181L679 180L671 180L676 176L674 174L672 170L669 167L677 168L679 168L684 167L686 163L688 162L691 162L692 160L695 157L697 156L698 154L699 151L700 149L706 148L709 147L712 150L716 151Z", "AF": "M685 146L688 147L691 146L693 146L695 145L697 143L698 145L698 147L701 147L703 146L708 146L707 147L703 148L698 150L699 152L698 155L694 156L694 158L693 161L690 162L688 163L684 165L681 168L678 168L674 169L672 165L669 162L668 158L668 156L670 151L675 152L678 150L680 147L683 145L685 146Z", "TJ": "M688 147L689 142L688 140L692 139L696 136L696 138L696 139L693 140L699 141L705 143L708 143L708 146L703 146L701 147L698 147L698 145L697 143L695 145L693 146L691 146L688 147Z", "KG": "M697 133L700 131L705 130L710 131L716 131L721 132L723 133L717 136L713 138L708 138L705 140L699 141L693 140L696 139L699 138L700 135L696 135L697 133Z", "TM": "M646 134L650 132L654 135L659 135L661 133L667 133L668 135L672 136L676 141L681 143L685 146L683 145L680 147L678 150L675 152L670 151L668 149L662 146L657 144L654 145L650 147L650 142L648 139L647 136L652 136L649 133L647 136L646 134Z", "IR": "M635 167L633 164L633 162L628 158L627 153L628 151L624 147L623 144L624 140L626 142L629 142L633 140L633 142L636 144L639 146L645 148L650 147L654 145L657 144L662 146L668 149L670 151L668 156L668 158L669 162L672 165L670 169L674 172L676 174L672 177L666 179L659 179L657 175L652 176L646 173L641 170L638 167L635 167Z", "SY": "M599 159L600 159L600 156L601 154L600 152L601 150L602 148L606 147L610 148L614 147L616 148L615 151L608 157L599 159Z", "AM": "M629 142L627 141L626 140L624 140L621 138L621 136L625 136L626 137L627 139L629 140L629 142Z", "SE": "M531 87L534 83L533 78L535 72L539 71L542 66L547 61L550 60L556 58L561 59L565 66L562 67L559 71L550 76L550 82L550 86L546 92L541 94L536 96L533 90L531 87Z", "BY": "M578 94L582 95L586 96L585 98L588 100L590 101L590 102L587 103L588 105L585 106L584 107L581 107L578 107L573 106L568 106L565 107L564 104L566 103L565 100L571 99L574 97L575 95L578 94Z", "UA": "M588 105L590 105L594 105L595 107L597 108L598 110L604 110L607 111L611 113L611 116L608 117L606 119L602 120L597 121L597 123L596 122L593 122L588 121L585 121L582 124L580 124L579 123L580 122L581 121L583 121L582 120L581 118L580 116L576 115L574 116L572 117L569 117L566 117L563 117L561 115L563 114L563 113L566 110L565 107L568 106L573 106L578 107L581 107L584 107L585 106L588 105Z", "PL": "M565 100L566 103L564 104L565 107L566 110L563 113L563 114L558 113L555 113L553 113L551 111L549 110L546 111L545 109L542 108L541 105L539 103L539 101L545 99L552 98L555 99L563 99L565 100Z", "AT": "M547 116L545 117L545 120L542 120L538 121L534 119L531 120L528 120L527 118L529 118L534 117L536 118L536 116L538 114L541 114L545 115L547 115L547 116Z", "HU": "M561 115L563 117L560 119L556 122L552 122L549 122L546 121L545 120L545 117L547 116L550 117L552 116L555 116L556 116L558 115L561 115Z", "MD": "M574 116L576 115L580 116L581 118L582 120L583 121L581 121L580 122L579 123L578 122L578 120L576 117L574 116Z", "RO": "M578 124L581 124L582 125L580 125L578 128L572 128L567 128L564 128L562 127L562 126L560 126L558 124L556 122L560 119L563 117L566 117L569 117L572 117L574 116L576 117L578 120L578 122L578 124Z", "LT": "M574 96L572 98L568 100L565 99L563 98L562 97L558 94L566 94L569 94L574 96Z", "LV": "M576 90L577 92L575 95L571 94L569 93L562 94L559 92L563 90L567 92L570 89L574 90L576 90Z", "EE": "M578 85L576 87L576 90L571 89L568 89L567 88L565 86L572 84L578 85Z", "DE": "M539 101L539 103L541 105L542 108L540 108L537 109L534 110L535 112L538 114L536 116L536 118L534 117L529 118L527 118L524 117L521 118L522 114L517 113L517 111L517 106L519 105L519 101L522 101L524 100L524 97L528 97L530 99L533 99L538 100L539 101Z", "BG": "M563 127L565 128L571 129L576 127L579 129L577 132L575 133L573 135L568 134L564 135L562 132L564 130L562 128L563 127Z", "GR": "M573 152L569 153L565 152L567 152L572 152L573 152ZM564 135L568 134L573 135L574 135L572 137L569 136L568 139L565 139L563 138L565 141L565 143L567 145L565 146L564 149L560 148L559 144L556 141L557 139L558 137L560 136L563 136L564 135Z", "TR": "M624 147L622 147L618 147L613 147L607 148L603 148L602 149L600 150L600 148L596 148L590 150L585 148L582 150L577 148L573 144L573 140L580 138L587 136L593 133L603 135L610 136L615 135L621 136L621 138L624 140L623 144L624 147ZM573 134L578 133L581 135L577 136L573 138L572 137L574 135L573 134Z", "AL": "M558 137L557 138L556 140L555 139L554 137L554 134L554 133L555 132L556 132L557 134L557 136L558 137Z", "HR": "M546 121L549 122L552 122L554 124L552 125L547 124L545 125L544 126L546 128L548 129L552 132L549 131L544 129L543 127L541 125L539 126L538 124L540 124L541 124L543 123L544 122L546 121Z", "CH": "M527 118L526 119L529 120L528 121L525 122L523 122L520 123L518 121L517 120L519 118L521 118L524 117L527 118Z", "LU": "M517 111L517 113L516 113L516 112L516 111L517 111Z", "BE": "M517 109L516 111L513 111L510 110L507 109L509 107L514 107L517 109Z", "NL": "M519 101L519 105L517 106L516 108L511 108L511 107L517 101L519 101Z", "PT": "M475 134L477 133L479 134L481 134L481 136L480 138L479 140L480 143L480 145L479 147L477 147L476 145L474 143L474 141L475 138L476 136L475 134Z", "ES": "M479 147L480 145L480 143L479 140L480 138L481 136L481 134L479 134L477 133L475 134L474 130L481 129L488 129L495 129L501 132L505 132L508 134L502 136L500 139L500 142L498 145L494 148L488 148L485 150L483 149L479 147Z", "IE": "M483 100L481 105L472 106L473 100L479 97L479 100L483 100Z", "SB": "M950 279L951 280L949 280L948 278L950 279ZM949 277L947 275L946 273L947 273L948 275L949 277ZM947 277L946 277L944 277L943 277L944 276L945 276L946 277L947 277ZM943 272L944 274L941 272L940 270L943 272ZM936 270L938 270L937 271L936 270L935 269L935 268L936 270Z", "NZ": "M991 361L989 365L986 365L987 362L983 360L985 358L985 354L984 351L981 348L981 346L984 348L987 353L988 352L991 355L994 354L995 357L992 359L992 361L991 361ZM971 371L975 368L978 365L980 362L981 365L984 365L983 367L980 370L979 372L976 375L972 379L968 379L963 378L964 375L969 372L971 371Z", "AU": "M910 363L912 367L911 370L908 371L906 371L904 367L902 363L907 364L910 363ZM850 339L845 342L843 344L839 344L835 344L831 346L829 347L826 347L821 346L820 343L821 342L822 339L820 335L820 332L818 329L817 326L815 323L815 321L817 323L816 319L815 318L816 315L816 312L817 313L821 310L824 308L826 308L830 306L831 305L836 305L838 302L840 299L842 296L844 297L844 295L845 293L848 291L849 290L850 289L853 288L857 291L860 292L861 288L862 286L865 284L868 284L866 281L869 282L873 283L876 284L878 283L880 284L879 287L878 288L876 291L879 293L882 295L885 297L887 298L891 298L892 296L894 292L893 290L893 286L894 284L895 281L896 280L897 283L898 284L899 287L900 290L902 291L904 293L905 297L906 299L907 303L912 305L913 307L916 312L918 313L919 315L922 318L925 322L925 326L926 331L925 334L925 338L921 342L919 345L918 349L917 353L915 355L909 356L906 358L902 357L901 356L897 357L893 356L889 354L888 350L884 349L884 346L880 348L882 345L883 341L879 345L876 346L874 342L873 341L867 339L860 338L853 340L850 339Z", "LK": "M727 229L726 233L722 231L723 223L726 226L727 229Z", "CN": "M804 199L802 196L806 194L808 195L806 198L804 199ZM723 132L725 130L728 124L731 119L738 118L741 115L744 113L747 116L753 120L753 124L760 125L765 127L768 131L776 132L783 132L790 134L795 133L803 132L809 129L810 128L811 125L815 126L822 123L826 120L832 120L830 117L826 118L822 117L823 114L827 112L831 109L835 106L834 103L840 102L847 102L852 106L854 109L859 113L864 117L870 116L874 118L872 122L866 124L865 127L863 131L861 131L856 133L854 135L851 136L845 139L839 141L838 141L839 138L835 137L831 141L826 142L830 145L833 147L838 146L840 147L835 150L831 153L835 157L839 162L837 165L839 167L838 172L834 175L830 182L822 187L817 188L815 189L808 191L805 194L805 191L800 190L796 188L794 186L790 187L785 187L782 188L781 191L781 189L778 190L776 186L774 183L771 180L774 176L773 173L770 171L768 170L765 169L759 170L755 173L752 172L749 172L746 172L742 172L736 170L733 169L729 166L725 166L719 162L720 160L719 157L716 151L711 148L708 146L708 143L705 143L705 140L708 138L713 138L717 136L723 133L723 132Z", "TW": "M838 182L835 189L834 185L837 180L838 182Z", "IT": "M529 120L531 120L534 120L538 122L537 123L534 125L535 128L539 131L544 133L544 135L549 136L551 138L549 138L546 139L547 142L545 144L544 144L545 142L543 139L541 137L538 136L534 134L529 131L527 128L523 127L521 129L519 127L520 124L519 122L522 123L524 122L526 121L529 121L529 120ZM541 144L542 146L542 148L538 147L535 144L541 144ZM524 136L527 137L526 141L523 141L523 136L524 136Z", "DK": "M528 97L524 97L522 93L524 91L527 90L529 91L529 93L530 94L527 96L528 97ZM534 94L535 96L534 98L531 96L530 95L534 94Z", "GB": "M483 100L481 100L479 100L480 98L479 97L481 97L484 98L483 100ZM491 102L492 100L490 98L486 97L486 95L484 94L484 89L488 87L489 90L495 90L491 95L494 95L499 99L501 103L504 105L504 108L498 109L492 109L487 110L484 111L491 107L486 107L488 105L487 101L491 102Z", "IS": "M460 65L462 69L451 73L445 73L440 71L438 69L432 68L439 66L447 66L455 65L460 65Z", "AZ": "M629 134L632 136L633 135L636 135L639 137L638 138L637 142L636 144L633 142L633 140L629 142L628 140L627 138L627 137L625 135L628 136L630 136L629 134ZM628 142L625 141L625 140L627 140L628 142Z", "GE": "M611 129L614 129L622 131L624 131L627 133L628 134L629 136L626 135L621 136L615 135L615 132L612 130L611 129Z", "PH": "M836 215L834 213L837 213L838 214L837 216L836 215ZM841 222L842 220L843 221L844 221L843 224L840 223L841 222ZM851 227L851 230L850 230L849 233L845 233L845 230L842 229L839 231L840 228L843 226L846 226L849 225L851 224L851 227ZM829 224L827 225L831 221L832 221L829 224ZM840 199L840 203L838 206L838 210L841 210L844 213L845 215L841 212L839 212L835 212L836 210L835 210L833 207L834 205L835 199L839 199L840 199ZM839 218L840 218L842 219L839 221L839 218ZM849 216L847 219L848 221L847 220L845 218L847 217L848 215L849 216Z", "MY": "M778 232L781 233L783 234L784 233L787 237L787 240L788 242L790 245L788 247L782 242L780 239L778 235L778 232ZM827 239L822 238L820 242L816 247L812 246L809 247L805 246L807 245L809 243L814 241L817 237L819 238L821 236L823 233L825 231L827 233L831 235L829 236L827 239Z", "BN": "M821 235L821 236L820 238L819 238L818 239L817 237L818 236L821 235Z", "SI": "M538 121L542 120L545 120L546 121L544 123L543 124L541 123L538 124L538 122L538 121Z", "FI": "M579 58L583 62L584 67L585 72L588 75L584 78L573 82L564 84L559 81L558 76L562 73L571 69L566 67L565 61L557 58L562 59L569 59L573 56L581 56L579 58Z", "SK": "M563 114L561 115L558 115L556 116L555 116L552 116L550 117L547 116L547 115L549 114L550 114L550 113L552 113L553 113L555 113L558 113L563 114Z", "CZ": "M542 108L545 109L546 111L549 110L551 111L552 113L550 113L550 114L549 114L547 115L545 115L541 114L538 114L535 112L534 110L537 109L540 108L542 108Z", "ER": "M601 210L602 205L603 202L607 200L609 206L614 210L617 213L620 215L618 215L616 213L614 211L609 210L607 210L604 211L601 210Z", "JP": "M894 141L892 147L891 150L886 154L877 157L875 154L867 156L867 158L863 164L862 160L859 158L864 155L868 152L877 151L882 148L887 144L889 137L893 135L894 141ZM902 128L904 130L898 133L892 134L888 132L893 129L894 123L900 127L902 128ZM868 157L871 156L874 155L873 158L870 158L868 158L868 157Z", "PY": "M338 306L339 311L343 311L346 313L346 317L348 316L349 318L348 321L345 326L340 326L340 321L337 319L331 316L327 308L328 305L336 304L338 306Z", "YE": "M644 197L648 204L645 206L642 208L635 211L633 211L630 213L627 213L625 214L624 215L621 215L620 212L619 209L619 208L619 206L620 204L621 201L622 202L626 202L630 202L632 202L636 198L644 197Z", "SA": "M597 168L601 168L604 167L606 165L608 161L612 161L624 169L632 169L634 171L637 174L639 176L639 178L640 180L641 181L643 182L643 183L653 188L655 189L644 197L634 200L631 203L629 202L626 202L622 202L620 203L619 205L618 203L616 200L614 196L611 194L608 189L607 184L604 183L603 180L602 178L599 174L596 172L597 170L597 168Z", "AQ": "M365 467L370 466L378 468L380 471L375 473L366 475L353 475L350 473L358 471L361 469L365 467ZM316 473L328 473L332 471L334 474L327 475L317 474L316 473ZM295 448L300 448L301 445L302 442L306 442L308 445L310 447L310 449L306 451L299 451L297 451L292 450L295 448ZM216 450L221 450L228 450L233 451L227 451L220 451L216 450ZM159 455L163 454L170 454L166 456L159 455ZM146 454L148 453L151 454L155 455L154 455L150 455L146 454ZM45 468L52 468L57 470L52 471L47 469L45 468ZM0 485L3 484L8 484L11 484L16 485L20 484L31 484L36 485L50 486L69 486L87 488L102 486L92 485L81 483L74 481L76 479L71 477L64 475L78 475L86 475L93 473L89 471L79 470L69 470L63 468L60 464L64 465L73 464L80 465L87 464L94 462L93 460L97 459L103 459L111 459L118 458L124 456L128 457L136 457L144 456L152 457L160 457L167 457L174 456L180 456L185 456L188 458L194 458L201 459L209 458L217 459L222 458L219 456L214 455L212 452L218 452L225 453L229 454L236 454L243 453L250 454L254 453L261 453L267 454L274 455L277 453L284 454L288 455L295 455L301 454L309 453L313 451L313 449L311 447L310 445L310 443L312 440L312 438L313 436L317 434L321 432L323 430L328 429L331 428L336 427L339 426L340 427L336 429L332 429L328 430L326 432L327 434L323 435L320 437L318 439L320 441L324 442L326 444L328 446L330 450L331 452L331 455L328 457L323 458L317 460L310 461L304 463L295 463L285 463L291 465L295 466L288 467L283 469L287 471L291 473L302 474L311 476L324 477L334 479L338 481L346 479L357 478L369 477L381 478L387 476L399 475L410 474L421 473L418 471L412 470L401 471L401 468L406 466L414 465L420 463L427 462L434 462L441 461L447 460L454 458L457 456L455 454L460 453L466 451L469 449L475 448L479 449L481 447L485 448L492 448L498 448L502 448L508 447L514 446L520 445L524 445L528 446L533 446L537 444L542 446L547 444L553 444L560 445L563 446L569 446L575 446L581 445L586 444L591 443L594 440L598 442L603 442L607 444L611 442L617 441L623 440L627 438L632 438L636 436L641 436L644 434L649 433L654 433L659 434L661 436L666 437L671 439L676 438L681 438L686 438L691 439L694 442L691 444L689 446L691 447L689 450L694 451L699 449L701 447L704 445L707 444L713 443L717 442L720 440L725 439L728 437L733 437L738 436L743 436L745 435L749 437L754 436L760 437L764 437L769 437L774 436L779 436L782 434L787 433L791 434L798 436L803 436L808 435L813 434L818 434L821 435L826 436L833 437L838 436L842 435L848 435L853 435L858 435L863 435L869 434L874 434L875 431L877 433L879 435L885 436L891 436L897 436L904 436L906 438L910 439L917 440L924 441L929 440L933 442L939 443L944 444L949 446L955 446L961 447L968 447L974 448L975 450L973 452L970 455L965 456L960 458L956 460L954 462L954 464L956 466L963 468L959 469L949 470L947 473L944 475L949 477L955 479L963 481L971 483L979 484L989 484L1000 485L0 485Z", "CY": "M591 152L592 152L593 152L593 153L594 153L590 154L591 152Z", "MA": "M494 152L495 156L497 159L493 161L490 162L487 165L483 167L476 170L476 173L474 175L472 175L468 175L467 178L461 184L459 189L453 191L453 189L455 187L456 184L458 182L459 179L462 176L464 173L468 172L471 169L473 163L474 160L479 156L483 152L486 151L490 152L494 152Z", "EG": "M602 189L581 189L569 179L569 167L569 164L574 162L579 164L582 163L586 162L589 164L592 164L595 163L597 168L596 171L594 173L592 171L590 167L593 173L596 179L599 184L599 186L602 189Z", "LY": "M569 189L566 194L555 190L541 186L538 186L532 183L529 182L528 180L527 176L527 173L527 170L526 166L528 164L530 162L532 160L535 159L539 159L544 163L550 165L554 165L555 162L558 159L564 159L566 161L569 161L569 164L569 167L569 179L569 189Z", "ET": "M633 228L621 236L617 238L614 239L611 239L608 240L607 240L602 238L599 237L598 235L595 231L593 229L592 227L594 226L595 220L597 219L600 215L601 210L605 208L609 209L611 210L614 212L617 214L617 216L616 218L618 219L619 220L619 222L621 224L633 228Z", "DJ": "M618 215L620 215L620 217L620 218L618 219L616 219L616 218L618 215Z", "UG": "M594 253L585 253L583 254L582 252L583 248L585 246L587 244L586 240L589 240L593 239L596 240L597 245L595 249L594 253Z", "RW": "M584 253L585 256L583 257L581 258L581 256L582 254L584 253Z", "BA": "M552 132L548 129L546 128L544 126L545 125L547 124L552 125L554 125L554 128L553 129L552 130L552 132Z", "MK": "M562 132L564 135L563 136L560 136L557 136L557 134L558 133L560 133L562 132Z", "RS": "M552 122L556 122L558 124L560 126L562 126L562 127L562 128L564 130L562 132L560 133L560 132L560 131L559 131L558 130L557 130L556 131L555 130L554 130L554 129L553 127L553 125L553 124L552 122Z", "ME": "M556 132L555 131L554 134L552 133L552 132L553 129L554 130L555 130L556 131L556 132Z", "XK": "M557 134L556 132L556 131L557 130L558 130L559 131L560 131L560 132L560 133L558 133L557 134Z", "TT": "M329 220L330 220L331 220L331 222L328 222L329 221L329 220Z", "SS": "M586 240L583 237L580 238L578 238L576 235L573 232L570 229L568 227L567 226L569 223L572 221L574 223L575 223L578 224L581 223L582 222L586 223L588 221L590 218L591 217L592 216L592 220L594 222L594 224L594 227L592 228L595 230L596 232L596 237L593 239L589 240L586 240Z" };

// src/map-bands.ts
var BAND_MIN_WIDTH = 700;
var BAND_MAX_HEIGHT = 10;
function bboxOfPairs(pairs) {
  if (pairs.length < 4) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const x = pairs[i];
    const y = pairs[i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, maxX, minY, maxY };
}
__name(bboxOfPairs, "bboxOfPairs");
function isBandBox(box) {
  return box.maxX - box.minX >= BAND_MIN_WIDTH && box.maxY - box.minY <= BAND_MAX_HEIGHT;
}
__name(isBandBox, "isBandBox");
function numbersIn(d) {
  return [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
}
__name(numbersIn, "numbersIn");
function splitSubpaths(d) {
  const out = [];
  const re = /[Mm][^Mm]*/g;
  let m;
  while (m = re.exec(d)) {
    const part = m[0].trim();
    if (part) out.push(part);
  }
  return out;
}
__name(splitSubpaths, "splitSubpaths");
function subpathIsBand(d) {
  const box = bboxOfPairs(numbersIn(d));
  return Boolean(box && isBandBox(box));
}
__name(subpathIsBand, "subpathIsBand");
function breakWideJumps(subpath) {
  const tokens = [...subpath.matchAll(/[A-Za-z]|-?\d+(?:\.\d+)?/g)].map((m) => m[0]);
  if (tokens.length < 5) return subpath;
  const out = [];
  let cmd = "";
  let x = NaN;
  let y = NaN;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z]$/.test(t)) {
      cmd = t;
      out.push(t);
      i++;
      continue;
    }
    const n = Number(t);
    if (cmd === "H" || cmd === "h") {
      if (Number.isFinite(x) && Math.abs(n - x) >= BAND_MIN_WIDTH) {
        out.push("M", String(n), String(y));
      } else {
        out.push(t);
      }
      x = n;
      i++;
      continue;
    }
    if (cmd === "V" || cmd === "v") {
      out.push(t);
      y = n;
      i++;
      continue;
    }
    if (i + 1 >= tokens.length) {
      out.push(t);
      i++;
      continue;
    }
    const nx = n;
    const ny = Number(tokens[i + 1]);
    if (Number.isFinite(x) && Number.isFinite(y) && Math.abs(nx - x) >= BAND_MIN_WIDTH && Math.abs(ny - y) <= BAND_MAX_HEIGHT) {
      out.push("M", String(nx), String(ny));
    } else {
      out.push(t, tokens[i + 1]);
    }
    x = nx;
    y = ny;
    i += 2;
  }
  return out.join(" ");
}
__name(breakWideJumps, "breakWideJumps");
function stripMapBands(d) {
  return splitSubpaths(d).filter((part) => !subpathIsBand(part)).map(breakWideJumps).join("");
}
__name(stripMapBands, "stripMapBands");

// src/charts.ts
var MONO = ["#2a2a2e", "#3f3f46", "#71717a", "#a1a1aa", "#e4e4e7"];
function sparklineArea(values, w = 220, h = 56) {
  if (!values.length || values.every((v) => v === 0)) {
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><line x1="0" y1="${h - 2}" x2="${w}" y2="${h - 2}" stroke="var(--hair)" /></svg>`;
  }
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - v / max * (h - 4) - 2).toFixed(1)}`);
  const d = `M0,${h} L${pts.join(" L")} L${w},${h} Z`;
  const line = `M${pts.join(" L")}`;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="${d}" fill="url(#spark-fill)" />
    <path d="${line}" fill="none" stroke="var(--chart-4)" stroke-width="1.5" />
  </svg>`;
}
__name(sparklineArea, "sparklineArea");
function sparklineLine(values, w = 220, h = 56) {
  if (!values.length || values.every((v) => v === 0)) {
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><line x1="0" y1="${h / 2}" x2="${w}" y2="${h / 2}" stroke="var(--hair)" /></svg>`;
  }
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - v / max * (h - 6) - 3).toFixed(1)}`);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="M${pts.join(" L")}" fill="none" stroke="var(--chart-4)" stroke-width="1.6" />
  </svg>`;
}
__name(sparklineLine, "sparklineLine");
function dualLine(series, w = 520, h = 140) {
  const hb = series.map((s) => s.heartbeats);
  const asks = series.map((s) => s.asks);
  if (!series.length || hb.every((v) => v === 0) && asks.every((v) => v === 0)) {
    return `<div class="empty">No heartbeats or Asks in this window.</div>`;
  }
  const max = Math.max(...hb, ...asks, 1);
  const step = series.length > 1 ? w / (series.length - 1) : w;
  const path = /* @__PURE__ */ __name((vals) => vals.map((v, i) => `${(i * step).toFixed(1)},${(h - 18 - v / max * (h - 28)).toFixed(1)}`).join(" L"), "path");
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="M${path(hb)}" fill="none" stroke="var(--chart-5)" stroke-width="1.6" />
    <path d="M${path(asks)}" fill="none" stroke="var(--accent)" stroke-width="1.4" />
  </svg>`;
}
__name(dualLine, "dualLine");
function layerPath(vals, w, h, max) {
  const step = vals.length > 1 ? w / (vals.length - 1) : w;
  const top = vals.map((v, i) => `${(i * step).toFixed(1)},${(h - 8 - v / max * (h - 16)).toFixed(1)}`);
  return `M0,${h} L${top.join(" L")} L${w},${h} Z`;
}
__name(layerPath, "layerPath");
function stackedTokens(tokens, w = 520, h = 140) {
  if (!tokens.length || tokens.every((t) => t.read + t.write + t.uncached === 0)) {
    return `<div class="empty">No cache token fields reported in this window.</div>`;
  }
  const max = Math.max(...tokens.map((t) => t.read + t.write + t.uncached), 1);
  const read = tokens.map((t) => t.read);
  const write = tokens.map((t) => t.read + t.write);
  const all = tokens.map((t) => t.read + t.write + t.uncached);
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="${layerPath(all, w, h, max)}" fill="var(--chart-2)" />
    <path d="${layerPath(write, w, h, max)}" fill="var(--chart-3)" />
    <path d="${layerPath(read, w, h, max)}" fill="var(--chart-5)" />
  </svg>`;
}
__name(stackedTokens, "stackedTokens");
function bars(items, w = 520, h = 140) {
  if (!items.length) return `<div class="empty">No seats in the field yet.</div>`;
  const max = Math.max(...items.map((i) => i.value), 1);
  const gap = 8;
  const bw = Math.min(28, Math.max(8, (w - gap * (items.length + 1)) / items.length));
  const rects = items.slice(0, 12).map((it, i) => {
    const bh = Math.max(2, it.value / max * (h - 28));
    const x = gap + i * (bw + gap);
    const y = h - 18 - bh;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="var(--chart-4)" />
        <text x="${(x + bw / 2).toFixed(1)}" y="${h - 6}" text-anchor="middle" class="tick">${escapeXml(it.label)}</text>`;
  }).join("");
  return `<svg class="chart" viewBox="0 0 ${w} ${h}">${rects}</svg>`;
}
__name(bars, "bars");
function heatmapGrid(values) {
  const cells = values.length ? values : Array.from({ length: 17 * 7 }, () => 0);
  const max = Math.max(...cells, 0);
  const cols = 17;
  const rows = 7;
  const size = 11;
  const gap = 3;
  const w = cols * (size + gap);
  const h = rows * (size + gap);
  let out = `<svg class="heat" viewBox="0 0 ${w} ${h}">`;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const v = cells[c * rows + r] ?? 0;
      const step = max === 0 ? 0 : Math.min(4, Math.ceil(v / max * 4));
      const fill = max === 0 ? "var(--chart-1)" : MONO[step];
      out += `<rect x="${c * (size + gap)}" y="${r * (size + gap)}" width="${size}" height="${size}" rx="2" fill="${fill}" />`;
    }
  }
  out += "</svg>";
  return out;
}
__name(heatmapGrid, "heatmapGrid");
function project(lat, lon) {
  return { x: (lon + 180) / 360 * 1e3, y: (90 - lat) / 180 * 500 };
}
__name(project, "project");
function scaleColor(devices, max) {
  if (max <= 0 || devices <= 0) return "var(--land)";
  const step = Math.min(4, Math.max(1, Math.ceil(devices / max * 4)));
  return MONO[step];
}
__name(scaleColor, "scaleColor");
function choropleth(countries, dots, variant) {
  const by = new Map(countries.map((c) => [c.iso, c.devices]));
  const max = Math.max(0, ...countries.map((c) => c.devices));
  const empty = countries.length === 0 && dots.length === 0;
  let land = "";
  for (const [iso, d] of Object.entries(WORLD_PATHS)) {
    const n = by.get(iso) ?? 0;
    const fill = empty || variant === "land" ? "var(--land)" : variant === "hatch" && n > 0 ? `url(#hatch-${Math.min(4, Math.max(1, Math.ceil(n / Math.max(max, 1) * 4)))})` : scaleColor(n, max);
    land += `<path data-iso="${iso}" d="${stripMapBands(d)}" fill="${fill}" />`;
  }
  let grid = "";
  if (variant === "graticule") {
    for (let lon = -180; lon <= 180; lon += 30) {
      const x = (lon + 180) / 360 * 1e3;
      grid += `<line x1="${x}" y1="0" x2="${x}" y2="500" class="grat" />`;
    }
    for (let lat = -60; lat <= 80; lat += 30) {
      const y = (90 - lat) / 180 * 500;
      grid += `<line x1="0" y1="${y}" x2="1000" y2="${y}" class="grat" />`;
    }
  }
  const marks = empty ? "" : dots.map((dot) => {
    const p = project(dot.lat, dot.lon);
    return `<circle class="dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.2" />`;
  }).join("");
  const caption = empty ? `<div class="empty map-empty">No heartbeats yet. The map stays empty until a seat checks in.</div>` : "";
  return `${caption}<svg class="world" viewBox="0 0 1000 500" role="img" aria-label="Unique devices by country">
    <defs>
      <pattern id="hatch-1" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--chart-3)" stroke-width="1"/></pattern>
      <pattern id="hatch-2" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="5" stroke="var(--chart-4)" stroke-width="1"/></pattern>
      <pattern id="hatch-3" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" stroke="var(--chart-5)" stroke-width="1.2"/></pattern>
      <pattern id="hatch-4" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="3" stroke="#fff" stroke-width="1.2"/></pattern>
    </defs>
    ${grid}${land}${marks}
  </svg>`;
}
__name(choropleth, "choropleth");
function escapeXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}
__name(escapeXml, "escapeXml");

// src/components/ui/status-badge.ts
var STATUS_BADGE_LABEL = {
  pending: "Pending",
  in_progress: "In progress",
  in_review: "In review",
  submitted: "Submitted",
  success: "Success",
  failed: "Failed",
  expired: "Expired"
};
var ICONS = {
  pending: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  failed: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  success: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  in_progress: '<circle cx="12" cy="12" r="10" stroke-dasharray="4 4"/>',
  in_review: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/><path d="m16 16 1.5 1.5"/>',
  expired: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l3 2"/>',
  submitted: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'
};
var ALIAS = {
  pending: "pending",
  failed: "failed",
  success: "success",
  expired: "expired",
  submitted: "submitted",
  "in-progress": "in_progress",
  in_progress: "in_progress",
  "in-review": "in_review",
  in_review: "in_review",
  "dead-letter": "expired",
  dead_letter: "expired"
};
function asStatusBadgeState(raw) {
  if (typeof raw !== "string") return null;
  return ALIAS[raw.trim().toLowerCase()] ?? null;
}
__name(asStatusBadgeState, "asStatusBadgeState");
function statusBadge(state, opts) {
  const resolved = asStatusBadgeState(state);
  if (!resolved) return "";
  const label = opts?.label ?? STATUS_BADGE_LABEL[resolved];
  return `<span class="status-badge status-${resolved}" data-status="${resolved}">
    <svg class="status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[resolved]}</svg>
    <span>${escapeHtml(label)}</span>
  </span>`;
}
__name(statusBadge, "statusBadge");
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}
__name(escapeHtml, "escapeHtml");
var STATUS_BADGE_CSS = `
.status-badge {
  display: inline-flex; align-items: center; gap: 5px;
  border: 1px solid var(--hair); border-radius: 999px;
  padding: 2px 8px 2px 6px;
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.04em;
  text-transform: uppercase; color: var(--ink2); background: rgba(255,255,255,0.03);
}
.status-icon { width: 11px; height: 11px; flex: 0 0 auto; }
.status-pending { color: #e4c36a; border-color: rgba(228,195,106,0.28); }
.status-failed { color: var(--danger); border-color: rgba(240,113,122,0.28); }
.status-success { color: var(--ok); border-color: rgba(131,192,146,0.28); }
.status-in_progress { color: #7dd3fc; border-color: rgba(125,211,252,0.28); }
.status-in_review { color: #facc15; border-color: rgba(250,204,21,0.28); }
.status-expired { color: #a1a1aa; border-color: rgba(161,161,170,0.28); }
.status-submitted { color: #a78bfa; border-color: rgba(167,139,250,0.32); }
.tab.on .status-badge { background: rgba(10,10,11,0.06); }
`;

// src/nav.ts
var NAV_SECTIONS = [
  {
    id: "analytics",
    label: "Analytics",
    items: [
      { id: "overview", label: "Overview" },
      { id: "realtime", label: "Realtime" },
      { id: "events", label: "Events" },
      { id: "profiles", label: "Profiles" },
      { id: "map", label: "Map" }
    ]
  },
  {
    id: "fleet",
    label: "Fleet",
    items: [
      { id: "macos", label: "macOS" },
      { id: "windows", label: "Windows" },
      { id: "licenses", label: "Licenses" }
    ]
  },
  {
    id: "ops",
    label: "Ops",
    items: [
      { id: "skills", label: "Skills" },
      { id: "keys", label: "Keys" }
    ]
  }
];
var NAV_IDS = NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.id));
var FORBIDDEN_NAV = ["scale", "change", "console"];

// src/ui.ts
var MISSING = "\u2014";
var CSS = `
@import url('https://cdn.jsdelivr.net/npm/geist@1.3.1/dist/fonts/geist-sans/style.min.css');
@import url('https://cdn.jsdelivr.net/npm/geist@1.3.1/dist/fonts/geist-mono/style.min.css');
:root, [data-theme="dark"] {
  --bg: #0a0a0b;
  --panel: #111113;
  --hair: rgba(255,255,255,0.10);
  --ink: rgba(255,255,255,0.94);
  --ink2: rgba(255,255,255,0.55);
  --ink3: rgba(255,255,255,0.38);
  --accent: #7C8CF8;
  --ok: #83C092;
  --danger: #F0717A;
  --land: #2a2a2e;
  --chart-1: #1a1a1d;
  --chart-2: #2a2a2e;
  --chart-3: #52525b;
  --chart-4: #a1a1aa;
  --chart-5: #e4e4e7;
  --nav: #0d0d0f;
  --nav-on: rgba(255,255,255,0.08);
  --dot: rgba(255,255,255,0.055);
  --mono: 'Geist Mono', ui-monospace, SFMono-Regular, monospace;
  --sans: 'Geist', Geist, Inter, system-ui, sans-serif;
}
[data-theme="light"] {
  --bg: #f4f4f5;
  --panel: #ffffff;
  --hair: rgba(15,15,17,0.10);
  --ink: #18181b;
  --ink2: rgba(24,24,27,0.62);
  --ink3: rgba(24,24,27,0.42);
  --land: #d4d4d8;
  --chart-1: #e4e4e7;
  --chart-2: #d4d4d8;
  --chart-3: #a1a1aa;
  --chart-4: #52525b;
  --chart-5: #18181b;
  --nav: #fafafa;
  --nav-on: rgba(15,15,17,0.06);
  --dot: rgba(15,15,17,0.08);
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    --bg: #f4f4f5;
    --panel: #ffffff;
    --hair: rgba(15,15,17,0.10);
    --ink: #18181b;
    --ink2: rgba(24,24,27,0.62);
    --ink3: rgba(24,24,27,0.42);
    --land: #d4d4d8;
    --chart-1: #e4e4e7;
    --chart-2: #d4d4d8;
    --chart-3: #a1a1aa;
    --chart-4: #52525b;
    --chart-5: #18181b;
    --nav: #fafafa;
    --nav-on: rgba(15,15,17,0.06);
    --dot: rgba(15,15,17,0.08);
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; color: var(--ink); font: 12px/1.45 var(--sans); }
body {
  background-color: var(--bg);
  background-image: radial-gradient(var(--dot) 1px, transparent 1px);
  background-size: 14px 14px;
}
a { color: var(--accent); text-decoration: none; }
.shell { display: grid; grid-template-columns: 228px 1fr; min-height: 100%; }
.rail {
  display: flex; flex-direction: column; gap: 10px;
  background: var(--nav); border-right: 1px solid var(--hair);
  padding: 14px 12px 16px; min-height: 100vh; position: sticky; top: 0;
}
.rail-brand { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.rail-brand h1 { margin: 0; font-size: 14px; font-weight: 650; letter-spacing: -0.03em; }
.rail-search {
  width: 100%; border: 1px solid var(--hair); background: var(--panel); color: var(--ink);
  border-radius: 8px; padding: 7px 10px; font: 12px var(--sans);
}
.rail-search::placeholder { color: var(--ink3); }
.rail nav { display: flex; flex-direction: column; gap: 14px; flex: 1; }
.nav-sec { display: flex; flex-direction: column; gap: 2px; }
.nav-sec p {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--ink3); margin: 0 6px 4px;
}
.nav-item {
  display: block; padding: 7px 8px; border-radius: 8px; color: var(--ink);
  font-size: 13px; font-weight: 550;
}
.nav-item:hover { background: var(--nav-on); }
.nav-item.on { background: var(--nav-on); font-weight: 650; }
.rail-foot { margin-top: auto; display: flex; flex-direction: column; gap: 8px; padding-top: 12px; }
.who { font-family: var(--mono); font-size: 10px; color: var(--ink2); word-break: break-all; }
.theme-btn {
  border: 1px solid var(--hair); background: transparent; color: var(--ink2);
  font: 11px/1 var(--mono); letter-spacing: 0.06em; text-transform: uppercase;
  padding: 6px 8px; border-radius: 8px; cursor: pointer;
}
.main { min-width: 0; }
.top {
  display: flex; align-items: baseline; justify-content: space-between; gap: 16px;
  padding: 12px 16px; border-bottom: 1px solid var(--hair);
  background: color-mix(in srgb, var(--bg) 86%, transparent); position: sticky; top: 0; z-index: 4;
}
.top h2 { margin: 0; font-size: 16px; font-weight: 650; letter-spacing: -0.03em; }
.eyebrow {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--ink3); margin: 0 0 8px;
}
.wrap { padding: 12px 16px 36px; display: grid; gap: 12px; }
.kpis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
.card {
  position: relative;
  background: var(--panel);
  border: 1px solid var(--hair);
  padding: 10px 12px 0;
  overflow: hidden;
}
.card::before, .card::after {
  content: ''; position: absolute; width: 8px; height: 8px; pointer-events: none;
  border-color: color-mix(in srgb, var(--ink) 28%, transparent); border-style: solid;
}
.card::before { top: -1px; left: -1px; border-width: 1px 0 0 1px; }
.card::after { bottom: -1px; right: -1px; border-width: 0 1px 1px 0; }
.card h3 { margin: 0; font-size: 13px; font-weight: 600; }
.kpi-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
.kpi .n { font-size: 28px; font-weight: 650; letter-spacing: -0.04em; line-height: 1; margin-top: 10px; }
.kpi .sub { font-family: var(--mono); font-size: 10px; color: var(--ink3); margin: 4px 0 8px; }
.spark { display: block; width: calc(100% + 24px); margin: 0 -12px; height: 56px; }
.chart { display: block; width: 100%; height: 140px; }
.world { display: block; width: 100%; height: auto; max-height: 420px; }
.heat { display: block; width: 100%; max-width: 280px; height: auto; }
.grat { stroke: color-mix(in srgb, var(--ink) 18%, transparent); stroke-width: 0.6; }
.dot { fill: var(--accent); stroke: var(--bg); stroke-width: 0.8; }
.tick { fill: var(--ink3); font-size: 9px; font-family: var(--mono); }
.tabs { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 8px; }
.tab {
  border: 1px solid transparent; background: transparent; color: var(--ink2);
  font: 11px/1 var(--mono); letter-spacing: 0.04em; text-transform: uppercase;
  padding: 4px 9px; border-radius: 999px; cursor: pointer;
}
.tab.on { background: var(--chart-5); color: var(--bg); }
[data-theme="light"] .tab.on, :root:not([data-theme="dark"]) .tab.on { color: #0a0a0b; background: #18181b; }
.pill {
  display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 10px;
  font-family: var(--mono); border: 1px solid var(--hair); color: var(--ink2);
}
.pill.up, .pill.hit { color: var(--ok); }
.pill.down { color: var(--danger); }
.chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 8px; border-radius: 999px; border: 1px solid var(--hair);
  font-family: var(--mono); font-size: 10px; color: var(--ink2); background: var(--nav-on);
}
.empty { color: var(--ink2); font-size: 12px; padding: 10px 0 12px; }
.map-empty { position: absolute; left: 12px; top: 42px; z-index: 1; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 7px 6px; border-bottom: 1px solid var(--hair); font-size: 12px; vertical-align: top; }
th { color: var(--ink3); font-weight: 500; font-family: var(--mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; }
button, .btn {
  background: transparent; color: var(--ink); border: 1px solid var(--hair);
  padding: 4px 9px; font-size: 11px; cursor: pointer; border-radius: 999px;
}
button.primary { background: var(--chart-5); color: var(--bg); border-color: transparent; font-weight: 600; }
button.danger { color: var(--danger); }
pre, textarea {
  width: 100%; background: color-mix(in srgb, var(--bg) 70%, #000); color: var(--ink);
  border: 1px solid var(--hair); padding: 8px; font: 11px var(--mono);
}
textarea { min-height: 120px; }
.row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.muted { color: var(--ink2); }
.legend { display: flex; gap: 12px; font-family: var(--mono); font-size: 10px; color: var(--ink3); padding: 6px 0 10px; }
.legend i { display: inline-block; width: 10px; height: 2px; background: var(--chart-5); vertical-align: middle; margin-right: 4px; }
.legend i.ask { background: var(--accent); }
.funnel { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
.crm-funnel { display: grid; gap: 6px; margin: 0 0 10px; }
.crm-funnel-row { display: grid; grid-template-columns: 88px 1fr auto; gap: 8px; align-items: center; }
.crm-funnel-track { height: 6px; background: var(--nav-on); border: 1px solid var(--hair); position: relative; overflow: hidden; }
.crm-funnel-ok { position: absolute; inset: 0 auto 0 0; background: var(--ok); opacity: 0.7; }
.crm-funnel-fail { position: absolute; inset: 0 0 0 auto; background: var(--danger); opacity: 0.7; }
.crm-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 0 0 10px; }
.crm-kpis .n { font-size: 22px; margin-top: 4px; }
.remote a { color: var(--accent); }
.heat-wrap { display: flex; gap: 16px; align-items: flex-start; }
.heat-meta { font-family: var(--mono); font-size: 10px; color: var(--ink3); }
.event {
  display: grid; grid-template-columns: 140px 160px 1fr 88px; gap: 10px; align-items: start;
  padding: 10px 4px; border-bottom: 1px solid var(--hair);
}
.event-name { font-weight: 650; }
.event-profile { color: var(--ink2); }
.event-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.event-time { font-family: var(--mono); font-size: 10px; color: var(--ink3); text-align: right; }
.live { display: inline-block; padding: 1px 7px; border-radius: 999px; background: #111; color: #fff; font: 10px var(--mono); letter-spacing: 0.08em; }
[data-theme="light"] .live { background: #18181b; }
.page[hidden] { display: none !important; }
@media (max-width: 980px) {
  .shell { grid-template-columns: 1fr; }
  .rail { position: relative; min-height: auto; }
  .kpis, .grid-2, .grid-3, .crm-kpis, .event { grid-template-columns: 1fr; }
}
`;
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}
__name(esc, "esc");
function when(ts) {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 16);
}
__name(when, "when");
function field(value) {
  if (!value || looksLikeSecret(value)) return MISSING;
  return esc(value);
}
__name(field, "field");
function kpiCard(opts) {
  return `<article class="card kpi">
    <div class="kpi-top"><h3>${esc(opts.title)}</h3>${opts.pill ?? ""}</div>
    <div class="n">${esc(opts.value)}</div>
    <div class="sub">${esc(opts.sub)}</div>
    ${opts.spark}
  </article>`;
}
__name(kpiCard, "kpiCard");
function renderNav() {
  const sections = NAV_SECTIONS.map((sec) => {
    const items = sec.items.map(
      (item) => `<a class="nav-item" data-nav="${item.id}" href="#${item.id}">${esc(item.label)}</a>`
    ).join("");
    return `<div class="nav-sec"><p>${esc(sec.label)}</p>${items}</div>`;
  }).join("");
  return `<nav id="rail-nav">${sections}</nav>`;
}
__name(renderNav, "renderNav");
function renderEvents(events) {
  if (!events.length) return '<div class="empty">No events yet.</div>';
  return events.map((e) => {
    const name = looksLikeSecret(e.name) ? "event" : e.name;
    const chips = e.chips.filter((c) => !looksLikeSecret(c.key) && !looksLikeSecret(c.value)).map((c) => `<span class="chip">${esc(c.key)} ${esc(c.value)}</span>`).join("");
    const profile = e.hostname || e.email || MISSING;
    return `<div class="event" data-event="${esc(e.id)}">
        <div class="event-name">${esc(name)}</div>
        <div class="event-profile">${field(profile === MISSING ? null : profile)}</div>
        <div class="event-chips">${chips}</div>
        <div class="event-time">${esc(when(e.ts))}</div>
      </div>`;
  }).join("");
}
__name(renderEvents, "renderEvents");
function renderProfiles(rows, osFilter) {
  const filtered = osFilter ? rows.filter((r) => osFilter === "darwin" ? r.os === "darwin" : r.os === "win" || r.os === "win32" || r.os === "windows") : rows;
  if (!filtered.length) return '<div class="empty">No seats on the fleet yet.</div>';
  const body = filtered.map(
    (r) => `<tr data-country="${esc(r.country || "")}" data-os="${esc(r.os)}">
        <td>${field(r.hostname)}</td>
        <td>${field(r.email)}</td>
        <td class="muted">${esc(r.os)}</td>
        <td class="muted">${esc(r.appVersion)}</td>
        <td class="muted">${esc(r.country || MISSING)}${r.city ? ` \xB7 ${esc(r.city)}` : ""}</td>
        <td class="muted">${esc(when(r.lastSeen))}</td>
        <td>${r.live ? '<span class="pill up">live</span>' : '<span class="muted">idle</span>'}</td>
      </tr>`
  ).join("");
  return `<table><thead><tr><th>Computer</th><th>SSO email</th><th>OS</th><th>Version</th><th>Country</th><th>Seen</th><th></th></tr></thead><tbody>${body}</tbody></table>`;
}
__name(renderProfiles, "renderProfiles");
function renderLicenses(rows) {
  if (!rows.length) return '<div class="empty">No seats on the fleet yet.</div>';
  const body = rows.map(
    (r) => `<tr>
        <td>${field(r.hostname)}</td>
        <td>${field(r.email)}</td>
        <td>${field(r.license)}</td>
        <td class="muted">${esc(r.os)}</td>
        <td class="muted">${esc(r.appVersion)}</td>
      </tr>`
  ).join("");
  return `<table><thead><tr><th>Computer</th><th>SSO email</th><th>License</th><th>OS</th><th>Version</th></tr></thead><tbody>${body}</tbody></table>`;
}
__name(renderLicenses, "renderLicenses");
function renderConsole(data) {
  const k = data.kpis;
  const maps = {
    land: choropleth(data.map.countries, data.map.dots, "land"),
    analytics: choropleth(data.map.countries, data.map.dots, "analytics"),
    graticule: choropleth(data.map.countries, data.map.dots, "graticule"),
    hatch: choropleth(data.map.countries, data.map.dots, "hatch")
  };
  const canRetry = /* @__PURE__ */ __name((status) => status === "failed" || status === "expired", "canRetry");
  const crmRows = data.crm.rows.map((r) => {
    const remote = r.remoteUrl ? `<a href="${esc(r.remoteUrl)}" rel="noreferrer">${esc(r.remoteId || "open")}</a>` : r.remoteId ? esc(r.remoteId) : "";
    const retry = canRetry(r.status) ? `<button data-retry="${esc(r.id)}">Retry</button>` : r.retryRequested ? '<span class="muted">retry asked</span>' : "";
    return `<tr data-status="${esc(r.status)}">
        <td>${statusBadge(r.status)}</td>
        <td>${esc(r.title)}${r.error ? `<div class="muted">${esc(r.error)}</div>` : ""}</td>
        <td class="muted">${esc(r.connector)}${r.action ? ` \xB7 ${esc(r.action)}` : ""}</td>
        <td class="muted remote">${remote}</td>
        <td class="muted">${r.attempt || ""}</td>
        <td class="muted">${esc(r.meetingHash || "")}</td>
        <td class="muted">${esc(when(r.ts))}</td>
        <td>${retry}</td>
      </tr>`;
  }).join("");
  const landing = data.crm.landing;
  const failRate = landing.failRatePct == null ? "hidden" : `${landing.failRatePct}%`;
  const funnelRows = data.crm.funnel.map((f) => {
    const att = Math.max(f.attempted, 1);
    const okW = Math.round(f.success / att * 100);
    const failW = Math.round(f.failed / att * 100);
    return `<div class="crm-funnel-row">
        <span class="muted">${esc(f.connector)}</span>
        <div class="crm-funnel-track" title="attempted ${f.attempted}">
          <span class="crm-funnel-ok" style="width:${okW}%"></span>
          <span class="crm-funnel-fail" style="width:${failW}%"></span>
        </div>
        <span class="muted">${f.attempted} att \xB7 ${f.submitted} sub \xB7 ${f.success} ok \xB7 ${f.failed} fail</span>
      </div>`;
  }).join("");
  const askRows = data.asks.map(
    (a) => `<tr>
        <td>${esc(a.mode)}</td>
        <td>${esc(a.preview)}</td>
        <td><span class="pill ${esc(a.cache_status)}">${esc(a.cache_status)}</span></td>
        <td class="muted">${esc(a.provider)}</td>
        <td><button data-reveal="${esc(a.id)}">Reveal</button></td>
      </tr>`
  ).join("");
  const costRows = data.cost.table.map(
    (r) => `<tr>
        <td>${esc(r.provider)}</td>
        <td>${esc(r.mode)}</td>
        <td>${r.asks}</td>
        <td>${r.read == null ? "not reported" : r.read}</td>
        <td>${r.write == null ? "not reported" : r.write}</td>
        <td>${r.uncached == null ? "not reported" : r.uncached}</td>
        <td>${r.estimate ?? "not reported"}</td>
      </tr>`
  ).join("");
  const timeline = data.change.timeline.map(
    (t) => `<tr>
        <td class="muted">${esc(when(t.ts))}</td>
        <td>${esc(t.action)}</td>
        <td class="muted">${esc(t.actor)}</td>
        <td>${esc(t.detail)}</td>
      </tr>`
  ).join("");
  const props = data.proposals.map(
    (p) => `<div class="card" data-proposal="${esc(p.id)}">
        <div class="row"><strong>${esc(p.skill_id)}</strong> <span class="pill">${esc(p.status)}</span> <span class="muted">from ${esc(p.from_version)}</span></div>
        <div class="muted">${esc(p.rationale)}</div>
        <div class="muted">${esc(p.created_by)} \xB7 ${esc(when(p.created_at))}</div>
        <textarea data-diff="${esc(p.id)}">${esc(p.diff)}</textarea>
        <div class="row">
          ${p.status === "pending" ? `<button class="primary" data-approve="${esc(p.id)}">Approve</button><button class="danger" data-reject="${esc(p.id)}">Reject</button>` : ""}
          ${p.status === "approved" ? `<button class="primary" data-push="${esc(p.id)}">Push</button>` : ""}
        </div>
      </div>`
  ).join("");
  const funnelTabs = CRM_FILTER_ORDER.map(
    (s) => `<button class="tab" data-crm-filter="${s}" type="button">${statusBadge(s)} ${data.crm.counts[s]}</button>`
  ).join("");
  const indexHint = k.lastIndexAt != null ? `last index ${when(k.lastIndexAt)}` : "last index not reported";
  const liveSeats = data.profiles.filter((p) => p.live);
  const vaultRows = data.keys.vault.map(
    (v) => `<tr>
        <td>${esc(v.provider)}</td>
        <td>${esc(v.label)}</td>
        <td class="muted">\xB7\xB7${esc(v.last4)}</td>
        <td>${esc(v.status)}</td>
      </tr>`
  ).join("");
  const mapCaption = "Unique devices by country from Cloudflare request.cf. No GPS from the app. No IP. Click a country to filter the fleet table. Empty is an empty world, not sample dots.";
  void FORBIDDEN_NAV;
  void NAV_IDS;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>M\xE9tis Operator</title>
<style>${CSS}${STATUS_BADGE_CSS}
svg path { vector-effect: non-scaling-stroke; }
#spark-defs { position: absolute; width: 0; height: 0; }
</style>
</head>
<body>
<svg id="spark-defs"><defs>
  <linearGradient id="spark-fill" x1="0" x2="0" y1="0" y2="1">
    <stop offset="0" stop-color="#e4e4e7" stop-opacity="0.28"/>
    <stop offset="1" stop-color="#e4e4e7" stop-opacity="0"/>
  </linearGradient>
</defs></svg>
<div class="shell">
  <aside class="rail">
    <div class="rail-brand"><h1>M\xE9tis</h1></div>
    <input class="rail-search" id="nav-search" type="search" placeholder="Search" autocomplete="off">
    ${renderNav()}
    <div class="rail-foot">
      <div class="who">${esc(data.email)}</div>
      <button class="theme-btn" id="theme-btn" type="button">Theme</button>
      <form method="post" action="/logout"><button class="theme-btn" type="submit">Sign out</button></form>
    </div>
  </aside>
  <div class="main">
    <header class="top">
      <h2 id="page-title">Overview</h2>
      <span class="live">LIVE ${k.live}</span>
    </header>

    <section class="page wrap" data-page="overview">
      <p class="eyebrow">Fleet</p>
      <div class="kpis">
        ${kpiCard({ title: "Live seats", value: String(k.live), sub: "last-seen under 2 minutes", spark: sparklineLine(k.liveSeries) })}
        ${kpiCard({ title: "DAU", value: String(k.dau), sub: `WAU ${k.wau}`, spark: sparklineArea(k.dauSeries) })}
        ${kpiCard({
    title: "API cost",
    value: k.costToday ?? "hidden",
    sub: k.cost7d ? `7d ${k.cost7d} \xB7 estimate, list price` : "estimate, list price \xB7 not reported",
    spark: sparklineArea(k.costSeries)
  })}
        ${kpiCard({
    title: "Prompt cache",
    value: k.cacheHit ?? "not reported",
    sub: "real provider fields only",
    spark: sparklineLine(k.hitSeries)
  })}
        ${kpiCard({
    title: "Versions in field",
    value: String(k.versions),
    sub: indexHint,
    spark: bars(data.scale.versions.slice(0, 6), 220, 56)
  })}
        ${kpiCard({
    title: "Pending diffs",
    value: String(k.pendingDiffs),
    sub: "Approve then Push",
    spark: sparklineLine(data.change.heatmap.slice(-24))
  })}
      </div>

      <div class="grid-2">
        <article class="card">
          <p class="eyebrow">Scale</p>
          <div class="tabs">
            <button class="tab on" data-scale="24h">24h</button>
            <button class="tab" data-scale="7d">7d</button>
          </div>
          <div id="scale-24">${dualLine(data.scale.hours24)}</div>
          <div id="scale-7" hidden>${dualLine(data.scale.days7)}</div>
          <div class="legend"><span><i></i>heartbeats</span><span><i class="ask"></i>Asks</span></div>
        </article>
        <article class="card">
          <p class="eyebrow">Mix</p>
          <div class="grid-2" style="gap:8px">
            <div>
              <div class="sub muted">App version</div>
              ${bars(data.scale.versions, 240, 140)}
            </div>
            <div>
              <div class="sub muted">OS</div>
              ${bars(data.scale.os, 240, 140)}
            </div>
          </div>
        </article>
      </div>

      <div class="grid-2">
        <article class="card">
          <p class="eyebrow">Cost tokens</p>
          ${stackedTokens(data.cost.tokens)}
          <div class="legend"><span><i></i>cache read</span><span class="muted">write / uncached underneath</span></div>
        </article>
        <article class="card">
          <p class="eyebrow">Cost by provider</p>
          ${data.cost.table.length ? `<table><thead><tr><th>Provider</th><th>Mode</th><th>Asks</th><th>Read</th><th>Write</th><th>Uncached</th><th>Estimate</th></tr></thead><tbody>${costRows}</tbody></table>
                 <div class="sub muted" style="padding-bottom:8px">estimate, list price. Missing usage is not reported, never $0.</div>` : '<div class="empty">No Asks with usage on the fleet yet.</div>'}
        </article>
      </div>

      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">Change</p>
        <div class="heat-wrap">
          ${heatmapGrid(data.change.heatmap)}
          <div class="heat-meta">Skill draft / approve / push and rollouts over 17 weeks. Empty cells are quiet days, not sample activity.</div>
        </div>
        ${timeline ? `<table><thead><tr><th>When</th><th>Action</th><th>Who</th><th>Version</th></tr></thead><tbody>${timeline}</tbody></table>` : '<div class="empty">No skill changes yet.</div>'}
      </article>

      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">Asks</p>
        ${askRows ? `<table><thead><tr><th>Mode</th><th>Preview</th><th>Cache</th><th>Provider</th><th></th></tr></thead><tbody>${askRows}</tbody></table>` : '<div class="empty">No Asks on the fleet yet.</div>'}
        <div id="reveal" class="muted" style="padding:8px 0"></div>
      </article>

      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">CRM landing</p>
        <div class="crm-kpis">
          ${kpiCard({ title: "Landed today", value: String(landing.landedToday), sub: "success with a CRM id when the connector returned one", spark: "" })}
          ${kpiCard({ title: "Fail rate", value: failRate, sub: "failed + expired over attempted", spark: "" })}
          ${kpiCard({ title: "Retries", value: String(landing.retries), sub: "Tony Retry or attempt over 1", spark: "" })}
          ${kpiCard({ title: "Dead letters", value: String(landing.deadLetters), sub: "max attempts, Expired", spark: "" })}
        </div>
        ${funnelRows ? `<p class="eyebrow">Funnel by connector</p><div class="crm-funnel">${funnelRows}</div>` : ""}
        <div class="funnel tabs" id="crm-filters">
          <button class="tab on" data-crm-filter="all">All ${data.crm.rows.length}</button>
          ${funnelTabs}
        </div>
        ${crmRows ? `<table id="crm-table"><thead><tr><th>Status</th><th>Title</th><th>Connector</th><th>Remote</th><th>Try</th><th>Meeting</th><th>When</th><th></th></tr></thead><tbody>${crmRows}</tbody></table>
               <div class="sub muted" style="padding-bottom:8px">Seven status chips filter real ingest. Retry on Failed or Expired tells that seat to processDue that id. Never auto-send from Intelligence, import, or index.</div>` : '<div class="empty">No CRM sends on the fleet yet.</div>'}
      </article>
    </section>

    <section class="page wrap" data-page="realtime" hidden>
      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">Live seats</p>
        ${liveSeats.length ? renderProfiles(liveSeats) : '<div class="empty">No live seats in the last two minutes.</div>'}
      </article>
      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">Live stream</p>
        <div id="rt-stream">${renderEvents(data.events.slice(0, 30))}</div>
      </article>
    </section>

    <section class="page wrap" data-page="events" hidden>
      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">Events</p>
        <div id="events-list">${renderEvents(data.events)}</div>
      </article>
    </section>

    <section class="page wrap" data-page="profiles" hidden>
      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">People</p>
        <div class="sub muted" style="padding-bottom:8px">Computer and SSO email from the seat. Missing fields are ${MISSING}, never invented.</div>
        ${renderProfiles(data.profiles)}
      </article>
    </section>

    <section class="page wrap" data-page="map" hidden>
      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">Map</p>
        <div class="tabs" id="map-tabs">
          <button class="tab" data-map="land">Land</button>
          <button class="tab on" data-map="analytics">Analytics</button>
          <button class="tab" data-map="graticule">Graticule</button>
          <button class="tab" data-map="hatch">Hatch</button>
        </div>
        <div id="map-root" style="position:relative">
          <div data-map-pane="land" hidden>${maps.land}</div>
          <div data-map-pane="analytics">${maps.analytics}</div>
          <div data-map-pane="graticule" hidden>${maps.graticule}</div>
          <div data-map-pane="hatch" hidden>${maps.hatch}</div>
        </div>
        <div class="sub muted" style="padding-bottom:8px">${esc(mapCaption)}</div>
        <table id="map-fleet"><thead><tr><th>Computer</th><th>SSO email</th><th>OS</th><th>Version</th><th>Country</th><th>Seen</th><th></th></tr></thead>
        <tbody>${data.profiles.map(
    (r) => `<tr data-country="${esc(r.country || "")}">
                <td>${field(r.hostname)}</td>
                <td>${field(r.email)}</td>
                <td class="muted">${esc(r.os)}</td>
                <td class="muted">${esc(r.appVersion)}</td>
                <td class="muted">${esc(r.country || MISSING)}</td>
                <td class="muted">${esc(when(r.lastSeen))}</td>
                <td></td>
              </tr>`
  ).join("") || `<tr><td colspan="7" class="empty">No seats on the fleet yet.</td></tr>`}</tbody></table>
      </article>
    </section>

    <section class="page wrap" data-page="macos" hidden>
      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">macOS</p>
        ${renderProfiles(data.profiles, "darwin")}
      </article>
    </section>

    <section class="page wrap" data-page="windows" hidden>
      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">Windows</p>
        ${renderProfiles(data.profiles, "win")}
      </article>
    </section>

    <section class="page wrap" data-page="licenses" hidden>
      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">Licenses</p>
        ${renderLicenses(data.profiles)}
      </article>
    </section>

    <section class="page wrap" data-page="skills" hidden>
      <article class="card" style="padding-bottom:10px">
        <div class="row" style="margin-bottom:8px">
          <p class="eyebrow" style="margin:0">Skills</p>
          <button data-draft="interview">Draft interview</button>
          <button data-draft="recruiting">Draft recruiting</button>
          <button data-draft="support">Draft support</button>
        </div>
        ${props || '<div class="empty">No skill upgrades waiting. Use Ask in a mode, then Draft.</div>'}
      </article>
    </section>

    <section class="page wrap" data-page="keys" hidden>
      <article class="card" style="padding-bottom:10px">
        <p class="eyebrow">Keys</p>
        <div class="sub muted" style="padding-bottom:8px">Presence only. Never a secret value, HMAC, PEM, or bearer string.</div>
        <table>
          <thead><tr><th>Binding</th><th>Status</th></tr></thead>
          <tbody>
            <tr><td>Ingest HMAC</td><td>${data.keys.ingestBound ? "bound" : "missing"}</td></tr>
            <tr><td>Prompt key</td><td>${data.keys.promptBound ? "bound" : "missing"}</td></tr>
            <tr><td>Skill signing</td><td>${data.keys.skillBound ? "bound" : "missing"}</td></tr>
          </tbody>
        </table>
        ${vaultRows ? `<p class="eyebrow" style="margin-top:14px">Vault</p><table><thead><tr><th>Provider</th><th>Label</th><th>Last4</th><th>Status</th></tr></thead><tbody>${vaultRows}</tbody></table>` : '<div class="empty">No provider keys stored on Operator. Seats keep their own keys.</div>'}
      </article>
    </section>
  </div>
</div>
<script>
async function api(path, body) {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  return r.json()
}
const titles = {
  overview: 'Overview', realtime: 'Realtime', events: 'Events', profiles: 'Profiles',
  map: 'Map', macos: 'macOS', windows: 'Windows', licenses: 'Licenses', skills: 'Skills', keys: 'Keys'
}
function route() {
  const raw = (location.hash || '#overview').replace('#', '')
  const id = titles[raw] ? raw : 'overview'
  document.querySelectorAll('[data-page]').forEach((p) => { p.hidden = p.getAttribute('data-page') !== id })
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.getAttribute('data-nav') === id))
  const t = document.getElementById('page-title')
  if (t) t.textContent = titles[id]
}
window.addEventListener('hashchange', route)
route()
const search = document.getElementById('nav-search')
if (search) search.addEventListener('input', () => {
  const q = search.value.trim().toLowerCase()
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const hit = !q || (a.textContent || '').toLowerCase().includes(q)
    a.hidden = !hit
  })
})
const themeBtn = document.getElementById('theme-btn')
function applyTheme(v) {
  if (v) document.documentElement.setAttribute('data-theme', v)
  else document.documentElement.removeAttribute('data-theme')
}
try { applyTheme(localStorage.getItem('metis-operator-theme')) } catch (e) {}
if (themeBtn) themeBtn.addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme')
  const next = cur === 'dark' ? 'light' : cur === 'light' ? '' : 'dark'
  applyTheme(next)
  try { if (next) localStorage.setItem('metis-operator-theme', next); else localStorage.removeItem('metis-operator-theme') } catch (e) {}
})
document.querySelectorAll('[data-scale]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-scale]').forEach((x) => x.classList.toggle('on', x === b))
  document.getElementById('scale-24').hidden = b.getAttribute('data-scale') !== '24h'
  document.getElementById('scale-7').hidden = b.getAttribute('data-scale') !== '7d'
}))
document.querySelectorAll('[data-map]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-map]').forEach((x) => x.classList.toggle('on', x === b))
  const v = b.getAttribute('data-map')
  document.querySelectorAll('[data-map-pane]').forEach((p) => { p.hidden = p.getAttribute('data-map-pane') !== v })
}))
document.querySelectorAll('#map-root path[data-iso]').forEach((p) => p.addEventListener('click', () => {
  const iso = p.getAttribute('data-iso')
  document.querySelectorAll('#map-fleet tbody tr').forEach((tr) => {
    tr.hidden = Boolean(iso) && tr.getAttribute('data-country') !== iso
  })
}))
document.querySelectorAll('[data-crm-filter]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-crm-filter]').forEach((x) => x.classList.toggle('on', x === b))
  const f = b.getAttribute('data-crm-filter')
  document.querySelectorAll('#crm-table tbody tr').forEach((tr) => {
    tr.hidden = f !== 'all' && tr.getAttribute('data-status') !== f
  })
}))
document.querySelectorAll('[data-reveal]').forEach((b) => b.addEventListener('click', async () => {
  const id = b.getAttribute('data-reveal')
  const j = await api('/v1/admin/asks/' + id)
  document.getElementById('reveal').textContent = j.ok ? (j.question || '(empty)') : (j.error || 'reveal failed')
}))
document.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', async () => {
  const id = b.getAttribute('data-approve')
  const diff = document.querySelector('[data-diff="' + id + '"]').value
  await api('/v1/admin/skills/' + id + '/approve', { diff })
  location.reload()
}))
document.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', async () => {
  const id = b.getAttribute('data-reject')
  await api('/v1/admin/skills/' + id + '/reject', { reason: 'rejected in console' })
  location.reload()
}))
document.querySelectorAll('[data-push]').forEach((b) => b.addEventListener('click', async () => {
  const id = b.getAttribute('data-push')
  await api('/v1/admin/skills/' + id + '/push', {})
  location.reload()
}))
document.querySelectorAll('[data-draft]').forEach((b) => b.addEventListener('click', async () => {
  await api('/v1/admin/skills/draft', { skillId: b.getAttribute('data-draft') })
  location.reload()
}))
document.querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', async () => {
  await api('/v1/admin/crm/' + b.getAttribute('data-retry') + '/retry', {})
  location.reload()
}))
<\/script>
</body></html>`;
}
__name(renderConsole, "renderConsole");
function renderLogin(error) {
  const err = error ? `<p class="login-err" role="alert">${esc(error)}</p>` : "";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>M\xE9tis Operator</title>
<style>
@import url('https://cdn.jsdelivr.net/npm/geist@1.3.1/dist/fonts/geist-sans/style.min.css');
@import url('https://cdn.jsdelivr.net/npm/geist@1.3.1/dist/fonts/geist-mono/style.min.css');
:root, [data-theme="dark"] {
  --bg: #0a0a0b; --panel: #111113; --hair: rgba(255,255,255,0.10);
  --ink: rgba(255,255,255,0.94); --ink2: rgba(255,255,255,0.55); --ink3: rgba(255,255,255,0.38);
  --accent: #7C8CF8; --danger: #F0717A;
  --mono: 'Geist Mono', ui-monospace, SFMono-Regular, monospace;
  --sans: 'Geist', Geist, Inter, system-ui, sans-serif;
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    --bg: #f4f4f5; --panel: #ffffff; --hair: rgba(15,15,17,0.10);
    --ink: #18181b; --ink2: rgba(24,24,27,0.62); --ink3: rgba(24,24,27,0.42);
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; color: var(--ink); font: 13px/1.45 var(--sans); background: var(--bg); }
.login {
  min-height: 100%; display: grid; place-items: center; padding: 24px;
}
.login-card {
  width: min(360px, 100%); background: var(--panel); border: 1px solid var(--hair);
  border-radius: 12px; padding: 22px 20px 20px;
}
.login-card p.eyebrow {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--ink3); margin: 0 0 6px;
}
.login-card h1 { margin: 0 0 16px; font-size: 18px; font-weight: 650; letter-spacing: -0.03em; }
.login-card label {
  display: block; font-size: 11px; color: var(--ink2); margin: 0 0 4px;
}
.login-card input {
  width: 100%; border: 1px solid var(--hair); background: var(--bg); color: var(--ink);
  border-radius: 8px; padding: 8px 10px; font: 13px var(--sans); margin: 0 0 12px;
}
.login-card button {
  width: 100%; border: 0; background: var(--accent); color: #fff;
  border-radius: 8px; padding: 9px 12px; font: 600 13px var(--sans); cursor: pointer;
}
.login-err { color: var(--danger); font-size: 12px; margin: 0 0 10px; }
.login-note { margin: 12px 0 0; font-size: 11px; color: var(--ink3); }
</style>
</head>
<body>
  <main class="login" data-login="1">
    <form class="login-card" method="post" action="/login" autocomplete="on">
      <p class="eyebrow">Operator</p>
      <h1>Sign in</h1>
      ${err}
      <label for="email">Email</label>
      <input id="email" name="email" type="email" required autocomplete="username">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" required autocomplete="current-password">
      <button type="submit">Sign in</button>
      <p class="login-note">Tony only. Two emails. The console stays closed until this form succeeds.</p>
    </form>
  </main>
</body></html>`;
}
__name(renderLogin, "renderLogin");

// src/index.ts
var RATE_WINDOW_MS = 6e4;
var RATE_MAX = 90;
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
__name(json, "json");
function html(body) {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}
__name(html, "html");
function isAdminPath(pathname) {
  return pathname === "/" || pathname.startsWith("/v1/admin");
}
__name(isAdminPath, "isAdminPath");
function redactedPreview(_question, mode) {
  return mode ? `${mode} ask` : "Ask";
}
__name(redactedPreview, "redactedPreview");
async function handleRequest(request, env, ctx, opts = {}) {
  const url = new URL(request.url);
  const store = opts.store ?? (env.DB ? d1Store(env.DB) : memoryStore());
  const now = opts.now ?? Date.now();
  const accessCtx = opts.access ? { access: opts.access } : ctx;
  if (url.pathname === "/health") {
    return json({
      ok: true,
      service: "metis-operator",
      configured: Boolean(env.OPERATOR_INGEST_SECRET && env.OPERATOR_PROMPT_KEY)
    });
  }
  if (url.pathname === "/login" && request.method === "POST") {
    return handleLogin(request, env, store, now);
  }
  if (url.pathname === "/logout" && request.method === "POST") {
    return new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": clearSessionCookie() } });
  }
  if (url.pathname === "/login" && request.method === "GET") {
    if (wantsJson(request)) return unauthorized();
    const ident = await adminIdentity(request, accessCtx, env, now);
    if (ident) return new Response(null, { status: 303, headers: { Location: "/" } });
    return html(renderLogin());
  }
  if (isAdminPath(url.pathname)) {
    const ident = await adminIdentity(request, accessCtx, env, now);
    if (!ident) {
      if (url.pathname === "/" && request.method === "GET" && !wantsJson(request)) {
        return html(renderLogin());
      }
      return unauthorized();
    }
    return adminRoute(request, url, env, store, ident.email, now);
  }
  if (url.pathname === "/v1/ingest" || url.pathname === "/v1/heartbeat" || url.pathname === "/v1/skills/manifest") {
    const bodyText = request.method === "GET" ? "" : await request.text();
    const hmac = await verifyIngestHmac(request, bodyText, env.OPERATOR_INGEST_SECRET, now, (n) => store.takeNonce(n, now));
    if (!hmac.ok) return json({ ok: false, error: hmac.error }, hmac.status);
    if (await store.hitRate(hmac.deviceId, now, RATE_WINDOW_MS, RATE_MAX)) {
      return json({ ok: false, error: "rate limited" }, 429);
    }
    const geo = opts.geo ?? geoFromRequest(request);
    if (url.pathname === "/v1/heartbeat") return heartbeat(store, hmac.deviceId, bodyText, now, geo);
    if (url.pathname === "/v1/skills/manifest") return manifest(store);
    return ingest(store, env, hmac.deviceId, bodyText, now, geo);
  }
  return json({ ok: false, error: "not found" }, 404);
}
__name(handleRequest, "handleRequest");
var LOGIN_WINDOW_MS = 6e4;
var LOGIN_MAX = 10;
async function handleLogin(request, env, store, now) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (await store.hitRate(`login:${ip}`, now, LOGIN_WINDOW_MS, LOGIN_MAX)) {
    return html(renderLogin("Sign-in failed"));
  }
  const { email, password } = await readLoginBody(request);
  const secret = env.OPERATOR_ADMIN_PASSWORD || "";
  const emailOk = isAdminEmail(email);
  const passOk = await passwordMatches(password, secret);
  if (!emailOk || !passOk) return html(renderLogin("Sign-in failed"));
  const cookie = await mintSessionCookie(normalizeAdminEmail(email), secret, now);
  return new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": cookie } });
}
__name(handleLogin, "handleLogin");
async function readLoginBody(request) {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const body = await request.json().catch(() => ({}));
    return {
      email: typeof body.email === "string" ? body.email : "",
      password: typeof body.password === "string" ? body.password : ""
    };
  }
  const form = await request.formData().catch(() => null);
  return {
    email: form && typeof form.get("email") === "string" ? String(form.get("email")) : "",
    password: form && typeof form.get("password") === "string" ? String(form.get("password")) : ""
  };
}
__name(readLoginBody, "readLoginBody");
async function adminRoute(request, url, env, store, email, now) {
  if (url.pathname === "/" && request.method === "GET") {
    const dash = await buildDashboard(store, email, now, keyFlags(env));
    return html(renderConsole(dash));
  }
  if (url.pathname === "/v1/admin/dashboard" && request.method === "GET") {
    return json(stripSecrets(await buildDashboard(store, email, now, keyFlags(env))));
  }
  if (url.pathname === "/v1/admin/summary" && request.method === "GET") {
    const dash = await buildDashboard(store, email, now);
    return json({
      ok: true,
      live: dash.kpis.live,
      dau: dash.kpis.dau,
      wau: dash.kpis.wau,
      costToday: dash.kpis.costToday,
      hitRate: dash.kpis.cacheHit,
      pending: dash.kpis.pendingDiffs
    });
  }
  if (url.pathname === "/v1/admin/asks" && request.method === "GET") {
    const asks = await store.listAsks(100);
    return json({
      ok: true,
      asks: asks.map((a) => ({ ...a, prompt_cipher: void 0, prompt_iv: void 0, question: void 0 }))
    });
  }
  const reveal = /^\/v1\/admin\/asks\/([^/]+)$/.exec(url.pathname);
  if (reveal && request.method === "GET") {
    const row = await store.getAsk(reveal[1]);
    if (!row) return json({ ok: false, error: "not found" }, 404);
    let question = "";
    if (row.prompt_cipher && row.prompt_iv) {
      question = await decryptPrompt(row.prompt_cipher, row.prompt_iv, env.OPERATOR_PROMPT_KEY);
    }
    await store.audit(crypto.randomUUID(), now, email, "reveal", row.id, "ask text");
    return json({ ok: true, id: row.id, question });
  }
  if (url.pathname === "/v1/admin/skills/draft" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const skillId = body.skillId || "general";
    const asks = (await store.listAsks(80)).filter((a) => a.mode === skillId || a.skill_id === skillId);
    const evidence = asks.map((a) => a.preview || "").filter(Boolean).slice(0, 8);
    const fromVersion = asks.find((a) => a.skill_version)?.skill_version || "1.1.0";
    const id = crypto.randomUUID();
    await store.putProposal({
      id,
      skill_id: skillId,
      from_version: fromVersion,
      evidence_json: JSON.stringify(evidence),
      diff: `# unified diff against ${skillId} v${fromVersion}
# Edit, then Approve. Push is a separate click.
`,
      rationale: evidence.length ? `Clustered ${evidence.length} recent Asks in ${skillId}.` : `No recent Asks in ${skillId} yet. Draft is a blank edit.`,
      status: "pending",
      created_by: email,
      created_at: now,
      decided_at: null,
      reject_reason: null
    });
    await store.audit(crypto.randomUUID(), now, email, "draft", null, skillId);
    return json({ ok: true, id });
  }
  const decide = /^\/v1\/admin\/skills\/([^/]+)\/(approve|reject|push)$/.exec(url.pathname);
  if (decide && request.method === "POST") {
    const id = decide[1];
    const action = decide[2];
    const row = await store.getProposal(id);
    if (!row) return json({ ok: false, error: "not found" }, 404);
    const body = await request.json().catch(() => ({}));
    if (action === "reject") {
      await store.putProposal({
        ...row,
        status: "rejected",
        reject_reason: body.reason || "rejected",
        decided_at: now
      });
      await store.audit(crypto.randomUUID(), now, email, "reject", null, row.skill_id);
      return json({ ok: true });
    }
    if (action === "approve") {
      await store.putProposal({
        ...row,
        status: "approved",
        diff: typeof body.diff === "string" ? body.diff : row.diff,
        decided_at: now
      });
      await store.audit(crypto.randomUUID(), now, email, "approve", null, row.skill_id);
      return json({ ok: true, pushed: false });
    }
    if (row.status !== "approved") return json({ ok: false, error: "approve first" }, 400);
    if (!env.OPERATOR_SKILL_PRIVATE_KEY) return json({ ok: false, error: "skill signing key missing" }, 500);
    const nextVersion = bump(row.from_version);
    const skillBody = skillPackBody(row.skill_id, nextVersion, body.body || row.diff);
    const digest = await sha256Hex(skillBody);
    const signed = await signSkillPack(
      { skillId: row.skill_id, version: nextVersion, sha256: digest, body: skillBody },
      env.OPERATOR_SKILL_PRIVATE_KEY
    );
    await store.putPack({
      id: crypto.randomUUID(),
      skill_id: row.skill_id,
      version: nextVersion,
      sha256: digest,
      body: skillBody,
      signed,
      pushed_at: now,
      pushed_by: email
    });
    await store.putProposal({ ...row, status: "pushed", decided_at: now });
    await store.audit(crypto.randomUUID(), now, email, "push", null, `${row.skill_id}@${nextVersion}`);
    return json({ ok: true, pushed: true, version: nextVersion, signed });
  }
  const crmRetry = /^\/v1\/admin\/crm\/([^/]+)\/retry$/.exec(url.pathname);
  if (crmRetry && request.method === "POST") {
    const row = await store.getCrm(crmRetry[1]);
    if (!row) return json({ ok: false, error: "not found" }, 404);
    if (row.status !== "failed" && row.status !== "expired") {
      return json({ ok: false, error: "only Failed or Expired can retry" }, 400);
    }
    await store.upsertCrm({
      ...row,
      status: "pending",
      retry_requested: 1,
      ts: now
    });
    await store.audit(crypto.randomUUID(), now, email, "crm-retry", null, row.id);
    return json({ ok: true, autoSend: false });
  }
  return json({ ok: false, error: "not found" }, 404);
}
__name(adminRoute, "adminRoute");
function bump(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) return "1.0.1";
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}
__name(bump, "bump");
function skillPackBody(skillId, version, source) {
  const trimmed = source.replace(/\r\n/g, "\n").trim();
  if (trimmed.startsWith("---")) {
    return trimmed.replace(/^version:\s*.*$/m, `version: ${version}`);
  }
  return `---
id: ${skillId}
version: ${version}
locked: true
---

${trimmed}
`;
}
__name(skillPackBody, "skillPackBody");
async function heartbeat(store, deviceId, bodyText, now, geo) {
  const body = bodyText ? JSON.parse(bodyText) : {};
  const seat = seatFromBody(deviceId, body, now, geo);
  await store.upsertSeat(seat);
  const pulseId = crypto.randomUUID();
  await store.insertPulse({
    id: pulseId,
    device_id: deviceId,
    ts: now,
    kind: "heartbeat",
    country: geo.country,
    city: geo.city
  });
  await store.insertEvent({
    id: pulseId,
    ts: now,
    kind: "heartbeat",
    actor: seat.sso_email,
    device_id: deviceId,
    country: geo.country,
    detail: safeEventDetail(seat.os)
  });
  await ingestCrmList(store, deviceId, body, now);
  const retries = await store.listCrmRetries(deviceId);
  return json({ ok: true, retry: retries.map((r) => r.id) });
}
__name(heartbeat, "heartbeat");
async function ingest(store, env, deviceId, bodyText, now, geo) {
  const body = JSON.parse(bodyText || "{}");
  const id = String(body.id || crypto.randomUUID());
  if (body.event === "rating") {
    await store.updateAskRating(id, String(body.rating || ""));
    const seat2 = seatFromBody(deviceId, body, now, geo);
    await store.insertEvent({
      id: crypto.randomUUID(),
      ts: now,
      kind: "rating",
      actor: seat2.sso_email,
      device_id: deviceId,
      country: geo.country,
      detail: safeEventDetail(String(body.rating || "rating"))
    });
    return json({ ok: true });
  }
  if (body.event === "crm") {
    if (body.confidential === true) return json({ ok: true, id, ingested: false });
    await upsertCrmEvent(store, deviceId, body, now);
    const seat2 = seatFromBody(deviceId, body, now, geo);
    await store.insertEvent({
      id: crypto.randomUUID(),
      ts: now,
      kind: "crm",
      actor: seat2.sso_email,
      device_id: deviceId,
      country: geo.country,
      detail: safeEventDetail(String(body.status || body.connector || "crm"))
    });
    return json({ ok: true, id });
  }
  let cipher = null;
  let iv = null;
  const question = typeof body.question === "string" ? body.question : "";
  if (question) {
    const enc4 = await encryptPrompt(question, env.OPERATOR_PROMPT_KEY);
    cipher = enc4.cipher;
    iv = enc4.iv;
  }
  const row = {
    id,
    device_id: deviceId,
    ts: typeof body.ts === "number" ? body.ts : now,
    mode: str(body.mode),
    skill_id: str(body.skillId),
    skill_version: str(body.skillVersion),
    provider: str(body.provider),
    model: str(body.model),
    ttft_ms: num(body.ttftMs),
    total_ms: num(body.totalMs),
    input_tokens: num(body.inputTokens),
    output_tokens: num(body.outputTokens),
    cache_read: num(body.cacheRead),
    cache_write: num(body.cacheWrite),
    cache_uncached: num(body.cacheUncached),
    cache_status: str(body.cacheStatus),
    cache_ttl: str(body.cacheTtl),
    outcome: str(body.outcome),
    rating: str(body.rating),
    prompt_cipher: cipher,
    prompt_iv: iv,
    preview: redactedPreview(question, str(body.mode) ?? void 0)
  };
  await store.insertAsk(row);
  const pulseId = crypto.randomUUID();
  await store.insertPulse({
    id: pulseId,
    device_id: deviceId,
    ts: row.ts,
    kind: "ask",
    country: geo.country,
    city: geo.city
  });
  const seat = seatFromBody(deviceId, body, now, geo);
  await store.upsertSeat(seat);
  await store.insertEvent({
    id: pulseId,
    ts: row.ts,
    kind: "ask",
    actor: seat.sso_email,
    device_id: deviceId,
    country: geo.country,
    detail: safeEventDetail(row.mode || row.cache_status || "ask")
  });
  return json({ ok: true, id });
}
__name(ingest, "ingest");
async function manifest(store) {
  const packs = await store.latestPacks();
  return json({
    ok: true,
    skills: packs.map((p) => ({
      skillId: p.skill_id,
      version: p.version,
      sha256: p.sha256,
      signed: p.signed
    }))
  });
}
__name(manifest, "manifest");
function lastIndexAt(body) {
  return typeof body.lastIndexAt === "number" && Number.isFinite(body.lastIndexAt) ? body.lastIndexAt : null;
}
__name(lastIndexAt, "lastIndexAt");
function seatFromBody(deviceId, body, now, geo) {
  return {
    device_id: deviceId,
    seat_hash: String(body.seatHash || deviceId),
    os: String(body.os || "unknown"),
    app_version: String(body.appVersion || ""),
    first_seen: now,
    last_seen: now,
    country: geo.country,
    city: geo.city,
    lat: geo.lat,
    lon: geo.lon,
    last_index_at: lastIndexAt(body),
    hostname: sanitizeOperatorHostname(body.hostname),
    sso_email: sanitizeOperatorSsoEmail(body.ssoEmail),
    license: typeof body.license === "string" && !looksLikeSecret(body.license) ? body.license.slice(0, 32) : null
  };
}
__name(seatFromBody, "seatFromBody");
function safeEventDetail(raw) {
  if (!raw) return null;
  const s = raw.trim().slice(0, 48);
  if (!s || looksLikeSecret(s)) return null;
  return s;
}
__name(safeEventDetail, "safeEventDetail");
function keyFlags(env) {
  return {
    ingestBound: Boolean(env.OPERATOR_INGEST_SECRET),
    promptBound: Boolean(env.OPERATOR_PROMPT_KEY),
    skillBound: Boolean(env.OPERATOR_SKILL_PRIVATE_KEY)
  };
}
__name(keyFlags, "keyFlags");
function meetingHashFromBody(body) {
  if (typeof body.meetingHash === "string" && /^[a-f0-9]{16,64}$/i.test(body.meetingHash.trim())) {
    return body.meetingHash.trim().toLowerCase().slice(0, 16);
  }
  if (typeof body.meetingFile === "string") {
    const base = body.meetingFile.replace(/^.*[/\\]/, "").trim();
    if (!base) return null;
    if (/^[a-f0-9]{16,64}$/i.test(base)) return base.toLowerCase().slice(0, 16);
  }
  return null;
}
__name(meetingHashFromBody, "meetingHashFromBody");
async function upsertCrmEvent(store, deviceId, body, now) {
  if (body.confidential === true) return;
  const status = asCrmStatus(body.status);
  if (!status) return;
  const id = String(body.id || crypto.randomUUID());
  const title = typeof body.title === "string" ? body.title.replace(/\s+/g, " ").trim().slice(0, 160) : "CRM send";
  const connector = typeof body.connector === "string" ? body.connector.slice(0, 32) : "unknown";
  const err = typeof body.error === "string" ? body.error.slice(0, 200) : null;
  const remoteId = typeof body.remoteId === "string" ? body.remoteId.slice(0, 80) : null;
  const remoteUrl = typeof body.remoteUrl === "string" && /^https:\/\//i.test(body.remoteUrl) ? body.remoteUrl.slice(0, 300) : null;
  const action = typeof body.action === "string" ? body.action.slice(0, 32) : null;
  const attempt = typeof body.attempt === "number" && Number.isFinite(body.attempt) ? Math.max(0, Math.floor(body.attempt)) : 0;
  const latencyMs = typeof body.latencyMs === "number" && Number.isFinite(body.latencyMs) ? Math.max(0, Math.floor(body.latencyMs)) : 0;
  const prev = await store.getCrm(id);
  await store.upsertCrm({
    id,
    device_id: deviceId,
    ts: typeof body.ts === "number" ? body.ts : now,
    status,
    title: title || "CRM send",
    connector,
    meeting_file: null,
    meeting_hash: meetingHashFromBody(body) ?? prev?.meeting_hash ?? null,
    last_error: err,
    retry_requested: 0,
    attempt: attempt || prev?.attempt || 0,
    latency_ms: latencyMs || prev?.latency_ms || 0,
    remote_id: remoteId ?? prev?.remote_id ?? null,
    remote_url: remoteUrl ?? prev?.remote_url ?? null,
    action: action ?? prev?.action ?? null
  });
}
__name(upsertCrmEvent, "upsertCrmEvent");
async function ingestCrmList(store, deviceId, body, now) {
  if (!Array.isArray(body.crm)) return;
  for (const item of body.crm.slice(0, 40)) {
    if (!item || typeof item !== "object") continue;
    await upsertCrmEvent(store, deviceId, item, now);
  }
}
__name(ingestCrmList, "ingestCrmList");
function stripSecrets(data) {
  return JSON.parse(
    JSON.stringify(data, (key, value) => {
      if (key === "prompt_cipher" || key === "prompt_iv" || key === "question" || key === "ip") return void 0;
      return value;
    })
  );
}
__name(stripSecrets, "stripSecrets");
function str(v) {
  return typeof v === "string" && v ? v : null;
}
__name(str, "str");
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
__name(num, "num");
var index_default = {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  }
};
export {
  ADMIN_EMAILS,
  index_default as default,
  handleRequest
};
//# sourceMappingURL=index.js.map
