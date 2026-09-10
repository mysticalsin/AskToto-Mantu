import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createApp } from './lib/app.mjs';

const ADMIN_TOKEN = 'dependency-compat-admin-token';
const requireFromHere = createRequire(import.meta.url);

let server;
let baseUrl;
let previousAdminToken;
let requestedAuditLimits;
let licenseLookups;

function packageVersion(requireFrom, name) {
  return requireFrom(`${name}/package.json`).version;
}

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: response.status, json, text };
}

describe('license-server dependency compatibility', () => {
  before(async () => {
    previousAdminToken = process.env.LICENSE_ADMIN_TOKEN;
    process.env.LICENSE_ADMIN_TOKEN = ADMIN_TOKEN;
    requestedAuditLimits = [];
    licenseLookups = 0;

    const store = {
      findByKey() {
        licenseLookups += 1;
        return undefined;
      },
      getAll() {
        return [];
      },
    };
    const auditLog = {
      async readLast(limit) {
        requestedAuditLimits.push(limit);
        return [{ id: 'newest' }, { id: 'older' }].slice(0, limit);
      },
      record() {},
    };

    server = createApp(store, auditLog).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousAdminToken === undefined) delete process.env.LICENSE_ADMIN_TOKEN;
    else process.env.LICENSE_ADMIN_TOKEN = previousAdminToken;
    delete Object.prototype.polluted;
  });

  it('resolves the patched body-parser and qs through both Express consumers', () => {
    const expressRequire = createRequire(requireFromHere.resolve('express/lib/utils.js'));
    const bodyParserRequire = createRequire(requireFromHere.resolve('body-parser/lib/read.js'));

    assert.equal(packageVersion(requireFromHere, 'express'), '4.22.2');
    assert.equal(packageVersion(expressRequire, 'body-parser'), '1.20.8');
    assert.equal(packageVersion(expressRequire, 'qs'), '6.16.0');
    assert.equal(packageVersion(bodyParserRequire, 'qs'), '6.16.0');
  });

  it('keeps the authenticated audit limit route bounded with prototype-shaped query keys', async () => {
    assert.equal(Object.prototype.polluted, undefined);
    const result = await request(
      '/admin/audit?limit=2&constructor[prototype][polluted]=yes&__proto__[polluted]=yes',
      { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } },
    );

    assert.equal(result.status, 200);
    assert.deepEqual(result.json, [{ id: 'newest' }, { id: 'older' }]);
    assert.deepEqual(requestedAuditLimits, [2]);
    assert.equal(Object.prototype.polluted, undefined);
  });

  it('parses ordinary JSON without allowing extra prototype-shaped fields to alter route behavior', async () => {
    const beforeLookups = licenseLookups;
    const result = await request('/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"licenseKey":"ATK-DOESNOTEXIST00000000","machineId":"machine-1","__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}}',
    });

    assert.equal(result.status, 200);
    assert.deepEqual(result.json, { ok: false, error: 'invalid' });
    assert.equal(licenseLookups, beforeLookups + 1);
    assert.equal(Object.prototype.polluted, undefined);
  });

  it('returns the stable invalid_json response for malformed JSON', async () => {
    const beforeLookups = licenseLookups;
    const result = await request('/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"licenseKey":',
    });

    assert.equal(result.status, 400);
    assert.deepEqual(result.json, { ok: false, error: 'invalid_json' });
    assert.equal(licenseLookups, beforeLookups);
  });

  it('returns a quiet safe 413 for JSON above the default 100kb limit before the route', async () => {
    const beforeLookups = licenseLookups;
    const rawMarker = 'RAW_BODY_MUST_NOT_ESCAPE';
    const oversized = JSON.stringify({
      licenseKey: 'ATK-DOESNOTEXIST00000000',
      machineId: 'machine-1',
      padding: rawMarker + 'x'.repeat(101 * 1024),
    });
    const originalConsoleError = console.error;
    const loggedErrors = [];
    let rejected;
    try {
      console.error = (...args) => loggedErrors.push(args.map(String).join(' '));
      rejected = await request('/activate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: oversized,
      });
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(rejected.status, 413);
    assert.deepEqual(rejected.json, { ok: false, error: 'payload_too_large' });
    assert.equal(rejected.text.includes(rawMarker), false);
    assert.equal(rejected.text.includes('PayloadTooLargeError'), false);
    assert.deepEqual(loggedErrors, []);
    assert.equal(licenseLookups, beforeLookups);

    const health = await request('/health');
    assert.equal(health.status, 200);
    assert.equal(health.json?.ok, true);
  });
});
