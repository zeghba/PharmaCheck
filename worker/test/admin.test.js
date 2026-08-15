/* Drives the Worker's admin API through its real fetch handler, with a
   fake KV namespace and Turso stubbed at the network boundary.

   These cover routing and the authorisation boundary — the two places a
   mistake is invisible until someone reaches something they shouldn't.

   Run with: npm test    (inside worker/) */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import worker from '../src/index.js';
import { mintToken } from '../src/auth.js';

const SECRET = 'test-session-secret';
const SETUP = 'test-setup-key';

/* A KV namespace that behaves like the real one for the operations the
   Worker actually uses, including prefix listing. */
function fakeKV(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    map,
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async put(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); },
    async list({ prefix = '' } = {}) {
      return {
        keys: [...map.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
        cursor: null
      };
    }
  };
}

function makeEnv(overrides = {}) {
  return {
    PHARMACIES: fakeKV(overrides.kv),
    SESSION_SECRET: SECRET,
    SETUP_KEY: SETUP,
    TURSO_ORG: overrides.org,
    TURSO_GROUP: overrides.group,
    TURSO_PLATFORM_TOKEN: overrides.token,
    ...overrides.env
  };
}

const req = (path, init = {}) => new Request('https://w.test' + path, {
  method: init.method || 'GET',
  headers: init.headers || {},
  body: init.body ? JSON.stringify(init.body) : undefined
});

const auth = (token) => ({ authorization: 'Bearer ' + token, 'content-type': 'application/json' });

async function adminToken() {
  const { token } = await mintToken(SECRET, { r: 'admin' });
  return token;
}

async function call(env, path, init) {
  const res = await worker.fetch(req(path, init), env);
  return { status: res.status, body: await res.json() };
}

/* ------------------------------------------------------------------ *
 * Admin sign-in
 * ------------------------------------------------------------------ */
test('the wrong setup key does not get a session', async () => {
  const { status, body } = await call(makeEnv(), '/v1/admin/signin', {
    method: 'POST', body: { setupKey: 'nope' }
  });
  assert.equal(status, 401);
  assert.equal(body.ok, false);
});

test('the right setup key returns an admin token', async () => {
  const { status, body } = await call(makeEnv(), '/v1/admin/signin', {
    method: 'POST', body: { setupKey: SETUP }
  });
  assert.equal(status, 200);
  assert.ok(body.token, 'a token comes back');
  assert.ok(body.expiresAt > Date.now(), 'and it has a future expiry');
});

/* ------------------------------------------------------------------ *
 * The boundary
 * ------------------------------------------------------------------ */
test('an unauthenticated request cannot reach the admin API', async () => {
  const { status } = await call(makeEnv(), '/v1/admin/pharmacies');
  assert.equal(status, 401);
});

test('a manager token cannot reach the admin API', async () => {
  // The whole point of the separate claim: a pharmacy manager who
  // somehow holds a valid token still gets nothing here.
  const { token } = await mintToken(SECRET, { p: 'central', a: 'mgr-1', r: 'manager' });
  const { status, body } = await call(makeEnv(), '/v1/admin/pharmacies', { headers: auth(token) });
  assert.equal(status, 401);
  assert.match(body.message, /admin app/i);
});

test('a vendor token cannot reach the admin API', async () => {
  const { token } = await mintToken(SECRET, { p: 'central', a: 'acc-2', r: 'vendor' });
  const { status } = await call(makeEnv(), '/v1/admin/pharmacies', { headers: auth(token) });
  assert.equal(status, 401);
});

test('an admin token cannot be used as a pharmacy token', async () => {
  // And the reverse, so an admin session cannot quietly push sales.
  const { status } = await call(makeEnv(), '/v1/pull', {
    method: 'POST', headers: auth(await adminToken())
  });
  assert.equal(status, 401);
});

test('an expired admin token is refused', async () => {
  const { token } = await mintToken(SECRET, { r: 'admin' }, -1000);
  const { status } = await call(makeEnv(), '/v1/admin/pharmacies', { headers: auth(token) });
  assert.equal(status, 401);
});

/* ------------------------------------------------------------------ *
 * Turso configuration from the app
 * ------------------------------------------------------------------ */
test('config starts empty and reports no source', async () => {
  const { body } = await call(makeEnv(), '/v1/admin/config', { headers: auth(await adminToken()) });
  assert.equal(body.config.platformToken.set, false);
  assert.equal(body.config.platformToken.source, null);
  assert.equal(body.config.org.value, '');
});

test('config saved from the app is reported as coming from the app', async () => {
  const env = makeEnv();
  const token = await adminToken();

  await call(env, '/v1/admin/config', {
    method: 'PUT', headers: auth(token),
    body: { org: 'my-org', group: 'default', token: 'tok-from-phone' }
  });

  const { body } = await call(env, '/v1/admin/config', { headers: auth(token) });
  assert.equal(body.config.org.value, 'my-org');
  assert.equal(body.config.org.source, 'admin-app');
  assert.equal(body.config.platformToken.set, true);
  assert.equal(body.config.platformToken.source, 'admin-app');
});

test('the platform token is never sent back to the app', async () => {
  const env = makeEnv();
  const token = await adminToken();
  await call(env, '/v1/admin/config', {
    method: 'PUT', headers: auth(token), body: { org: 'o', token: 'super-secret-value' }
  });
  const { body } = await call(env, '/v1/admin/config', { headers: auth(token) });
  assert.ok(!JSON.stringify(body).includes('super-secret-value'), 'the token stays on the server');
});

test('a wrangler secret wins over whatever the app stored', async () => {
  // Configuring it properly later must silently retire the app's copy,
  // or an operator who tidies up would not actually have tidied up.
  const env = makeEnv({ org: 'env-org', token: 'env-token' });
  const token = await adminToken();

  await call(env, '/v1/admin/config', {
    method: 'PUT', headers: auth(token), body: { org: 'app-org', token: 'app-token' }
  });

  const { body } = await call(env, '/v1/admin/config', { headers: auth(token) });
  assert.equal(body.config.org.value, 'env-org');
  assert.equal(body.config.org.source, 'worker-secret');
  assert.equal(body.config.platformToken.source, 'worker-secret');
});

test('an empty token clears the stored one', async () => {
  const env = makeEnv();
  const token = await adminToken();
  await call(env, '/v1/admin/config', { method: 'PUT', headers: auth(token), body: { token: 'x' } });
  await call(env, '/v1/admin/config', { method: 'PUT', headers: auth(token), body: { token: '' } });
  const { body } = await call(env, '/v1/admin/config', { headers: auth(token) });
  assert.equal(body.config.platformToken.set, false);
});

test('health reports app-supplied credentials as configured', async () => {
  const env = makeEnv();
  const token = await adminToken();
  let { body } = await call(env, '/v1/health');
  assert.equal(body.configured.platformToken, false);

  await call(env, '/v1/admin/config', {
    method: 'PUT', headers: auth(token), body: { org: 'o', token: 't' }
  });

  ({ body } = await call(env, '/v1/health'));
  assert.equal(body.configured.platformToken, true);
  assert.equal(body.configured.org, true);
});

test('health never leaks the organisation name or a credential', async () => {
  const env = makeEnv({ org: 'acme-pharma', token: 'plat-token' });
  const { body } = await call(env, '/v1/health');
  const text = JSON.stringify(body);
  assert.ok(!text.includes('acme-pharma'));
  assert.ok(!text.includes('plat-token'));
});

/* ------------------------------------------------------------------ *
 * Testing the credentials against Turso
 * ------------------------------------------------------------------ */
test('config/test resolves rather than being swallowed by /config', async () => {
  const env = makeEnv({ org: 'my-org', token: 'tok', group: 'default' });
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200, json: async () => ({ groups: [{ name: 'default' }] }), text: async () => ''
  });
  try {
    const { body } = await call(env, '/v1/admin/config/test', { headers: auth(await adminToken()) });
    assert.equal(body.ok, true);
    assert.match(body.message, /my-org/);
  } finally { globalThis.fetch = real; }
});

test('a rejected platform token is reported plainly', async () => {
  const env = makeEnv({ org: 'my-org', token: 'bad' });
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => '' });
  try {
    const { body } = await call(env, '/v1/admin/config/test', { headers: auth(await adminToken()) });
    assert.equal(body.ok, false);
    assert.match(body.message, /rejected/i);
  } finally { globalThis.fetch = real; }
});

test('a missing group is called out, with the ones that do exist', async () => {
  const env = makeEnv({ org: 'my-org', token: 'tok', group: 'ghost' });
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200, json: async () => ({ groups: [{ name: 'default' }, { name: 'eu' }] }), text: async () => ''
  });
  try {
    const { body } = await call(env, '/v1/admin/config/test', { headers: auth(await adminToken()) });
    assert.equal(body.ok, false);
    assert.match(body.message, /ghost/);
    assert.match(body.message, /default, eu/);
  } finally { globalThis.fetch = real; }
});

/* ------------------------------------------------------------------ *
 * Pharmacy listing
 * ------------------------------------------------------------------ */
test('an estate with no pharmacies lists cleanly', async () => {
  const { body } = await call(makeEnv(), '/v1/admin/pharmacies', { headers: auth(await adminToken()) });
  assert.deepEqual(body.pharmacies, []);
});

test('pharmacies come back newest first', async () => {
  const env = makeEnv({ kv: {
    'pharmacy:alpha': JSON.stringify({ code: 'alpha', dbName: 'pharmacheck-alpha', createdAt: 1000 }),
    'pharmacy:beta':  JSON.stringify({ code: 'beta',  dbName: 'pharmacheck-beta',  createdAt: 3000 }),
    'config:turso':   JSON.stringify({ org: 'o' })
  } });

  const { body } = await call(env, '/v1/admin/pharmacies', { headers: auth(await adminToken()) });
  assert.equal(body.pharmacies.length, 2, 'the config key is not mistaken for a pharmacy');
  assert.equal(body.pharmacies[0].code, 'beta');
  assert.equal(body.pharmacies[1].code, 'alpha');
});

test('creating a pharmacy without Turso credentials says so', async () => {
  const { status, body } = await call(makeEnv(), '/v1/admin/pharmacies', {
    method: 'POST', headers: auth(await adminToken()),
    body: { code: 'central', managerName: 'A', managerPin: '1234' }
  });
  assert.equal(status, 503);
  assert.match(body.message, /Settings|wrangler/);
});

test('a duplicate pharmacy code is refused', async () => {
  const env = makeEnv({ org: 'o', token: 't', kv: {
    'pharmacy:central': JSON.stringify({ code: 'central', dbName: 'pharmacheck-central', createdAt: 1 })
  } });
  const { status, body } = await call(env, '/v1/admin/pharmacies', {
    method: 'POST', headers: auth(await adminToken()),
    body: { code: 'Central', managerName: 'A', managerPin: '1234' }
  });
  assert.equal(status, 400);
  assert.match(body.message, /already exists/);
});

test('a bad manager PIN is refused before any database is made', async () => {
  const env = makeEnv({ org: 'o', token: 't' });
  const { status, body } = await call(env, '/v1/admin/pharmacies', {
    method: 'POST', headers: auth(await adminToken()),
    body: { code: 'pin-check-only', managerName: 'A', managerPin: '12' }
  });
  assert.equal(status, 400);
  assert.match(body.message, /4 digits/);
});

test('archiving a pharmacy stops it resolving, cache included', async () => {
  // The first archive resolves the pharmacy, which populates the isolate's
  // memo. If archiving did not evict it, the second call would still find
  // it there and cheerfully archive it again.
  const env = makeEnv({ kv: {
    'pharmacy:doomed': JSON.stringify({ code: 'doomed', dbName: 'pharmacheck-doomed', createdAt: 1 })
  } });
  const token = await adminToken();

  const first = await call(env, '/v1/admin/pharmacies/doomed', { method: 'DELETE', headers: auth(token), body: {} });
  assert.equal(first.status, 200);
  assert.equal(first.body.dropped, false, 'the database is kept by default');

  const second = await call(env, '/v1/admin/pharmacies/doomed', { method: 'DELETE', headers: auth(token), body: {} });
  assert.equal(second.status, 404, 'it is really gone, not just gone from KV');
});

test('unknown admin routes 404 rather than falling through', async () => {
  const { status } = await call(makeEnv(), '/v1/admin/nonsense', { headers: auth(await adminToken()) });
  assert.equal(status, 404);
});
