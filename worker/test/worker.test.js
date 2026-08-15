/* Unit tests for the parts of the Worker that are easy to get subtly
   wrong: the Hrana wire encoding, PIN hashing and the session token.

   Run with: npm test    (inside worker/)
   Needs Node 20+ for WebCrypto, fetch, btoa and atob as globals. */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toValue, fromValue, httpUrl, Db, DbError } from '../src/hrana.js';
import { hashPin, randomSalt, safeEqual, mintToken, readToken } from '../src/auth.js';
import { normaliseCode, dbNameFor } from '../src/turso.js';

/* ------------------------------------------------------------------ *
 * Hrana value encoding
 * ------------------------------------------------------------------ */
test('integers travel as strings, floats as numbers', () => {
  assert.deepEqual(toValue(42), { type: 'integer', value: '42' });
  assert.deepEqual(toValue(12.5), { type: 'float', value: 12.5 });
  assert.deepEqual(toValue(null), { type: 'null' });
  assert.deepEqual(toValue(undefined), { type: 'null' });
  assert.deepEqual(toValue('x'), { type: 'text', value: 'x' });
  assert.deepEqual(toValue(true), { type: 'integer', value: '1' });
});

test('a price survives the round trip', () => {
  // 1450.00 is a real catalogue price; losing its type turns money into
  // a string and every total into concatenation.
  assert.equal(fromValue(toValue(1450)), 1450);
  assert.equal(fromValue(toValue(12.5)), 12.5);
  assert.equal(fromValue(toValue(0)), 0);
  assert.equal(fromValue({ type: 'integer', value: '9007199254740991' }), 9007199254740991);
  assert.equal(fromValue({ type: 'null' }), null);
});

test('NaN and Infinity become null rather than invalid JSON', () => {
  assert.deepEqual(toValue(NaN), { type: 'null' });
  assert.deepEqual(toValue(Infinity), { type: 'null' });
});

test('every spelling of a Turso URL resolves to https', () => {
  assert.equal(httpUrl('libsql://db-org.turso.io'), 'https://db-org.turso.io');
  assert.equal(httpUrl('wss://db-org.turso.io'), 'https://db-org.turso.io');
  assert.equal(httpUrl('https://db-org.turso.io/'), 'https://db-org.turso.io');
  assert.equal(httpUrl('  libsql://db-org.turso.io//  '), 'https://db-org.turso.io');
});

/* ------------------------------------------------------------------ *
 * Db against a stubbed endpoint
 * ------------------------------------------------------------------ */
function stubFetch(handler) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = real; };
}

function okBody(results) {
  return {
    ok: true,
    json: async () => ({ baton: null, base_url: null, results }),
    text: async () => ''
  };
}

function executeResult(cols, rows, affected) {
  return {
    type: 'ok',
    response: {
      type: 'execute',
      result: {
        cols: cols.map((name) => ({ name, decltype: null })),
        rows,
        affected_row_count: affected || 0,
        last_insert_rowid: null
      }
    }
  };
}

test('rows come back as objects keyed by column name', async () => {
  const restore = stubFetch(async () => okBody([
    executeResult(
      ['name', 'qty', 'price'],
      [[{ type: 'text', value: 'Paracetamol 500mg' }, { type: 'integer', value: '640' }, { type: 'float', value: 3.2 }]]
    ),
    { type: 'ok', response: { type: 'close' } }
  ]));

  try {
    const db = new Db('libsql://x.turso.io', 't');
    const row = await db.one('SELECT * FROM medicines');
    assert.deepEqual(row, { name: 'Paracetamol 500mg', qty: 640, price: 3.2 });
  } finally { restore(); }
});

test('one() returns null rather than undefined on no rows', async () => {
  const restore = stubFetch(async () => okBody([
    executeResult(['name'], []),
    { type: 'ok', response: { type: 'close' } }
  ]));
  try {
    const db = new Db('libsql://x.turso.io', 't');
    assert.equal(await db.one('SELECT 1'), null);
  } finally { restore(); }
});

test('tx() strips the BEGIN and COMMIT results so indexes line up', async () => {
  let sent = null;
  const restore = stubFetch(async (url, init) => {
    sent = JSON.parse(init.body);
    return okBody([
      executeResult([], [], 0),          // BEGIN
      executeResult([], [], 1),          // the caller's first statement
      executeResult([], [], 1),          // the caller's second
      executeResult([], [], 0),          // COMMIT
      { type: 'ok', response: { type: 'close' } }
    ]);
  });

  try {
    const db = new Db('libsql://x.turso.io', 't');
    const out = await db.tx([['UPDATE a SET b = 1'], ['INSERT INTO c VALUES (1)']]);

    assert.equal(out.length, 2, 'caller sees only their own statements');
    assert.equal(sent.requests[0].stmt.sql, 'BEGIN');
    assert.equal(sent.requests[3].stmt.sql, 'COMMIT');
    assert.equal(sent.requests[4].type, 'close');
  } finally { restore(); }
});

test('a statement error is raised, not silently returned as data', async () => {
  const restore = stubFetch(async () => okBody([
    { type: 'error', error: { message: 'no such table: medicines', code: 'SQLITE_UNKNOWN' } }
  ]));
  try {
    const db = new Db('libsql://x.turso.io', 't');
    await assert.rejects(() => db.all('SELECT 1'), (e) => e instanceof DbError && /no such table/.test(e.message));
  } finally { restore(); }
});

test('an HTTP failure carries its status through', async () => {
  const restore = stubFetch(async () => ({
    ok: false, status: 401, text: async () => 'unauthorized', json: async () => ({})
  }));
  try {
    const db = new Db('libsql://x.turso.io', 'bad');
    await assert.rejects(() => db.all('SELECT 1'), (e) => e.status === 401);
  } finally { restore(); }
});

/* ------------------------------------------------------------------ *
 * PINs
 * ------------------------------------------------------------------ */
test('the same PIN and salt always give the same hash', async () => {
  const salt = randomSalt();
  assert.equal(await hashPin('1234', salt), await hashPin('1234', salt));
});

test('the same PIN under two salts does not', async () => {
  // Otherwise one leaked hash tells you every account sharing that PIN.
  assert.notEqual(await hashPin('1234', randomSalt()), await hashPin('1234', randomSalt()));
});

test('a wrong PIN does not match', async () => {
  const salt = randomSalt();
  const stored = await hashPin('1234', salt);
  assert.equal(safeEqual(await hashPin('1235', salt), stored), false);
  assert.equal(safeEqual(await hashPin('1234', salt), stored), true);
});

test('safeEqual rejects different lengths without throwing', () => {
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
});

/* ------------------------------------------------------------------ *
 * Session tokens
 * ------------------------------------------------------------------ */
const SECRET = 'test-secret-not-a-real-one';

test('a minted token reads back with its claims', async () => {
  const { token } = await mintToken(SECRET, { p: 'central', a: 'acc-1', r: 'manager' });
  const claims = await readToken(SECRET, token);
  assert.equal(claims.p, 'central');
  assert.equal(claims.a, 'acc-1');
  assert.equal(claims.r, 'manager');
});

test('a token signed with another secret is refused', async () => {
  const { token } = await mintToken('other-secret', { p: 'central', a: 'acc-1', r: 'manager' });
  assert.equal(await readToken(SECRET, token), null);
});

test('editing the role in a token invalidates it', async () => {
  // The whole point: a vendor cannot promote themselves by editing the
  // payload, because the signature covers it.
  const { token } = await mintToken(SECRET, { p: 'central', a: 'acc-2', r: 'vendor' });
  const [payload, sig] = token.split('.');

  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  claims.r = 'manager';
  const forged = Buffer.from(JSON.stringify(claims)).toString('base64url') + '.' + sig;

  assert.equal(await readToken(SECRET, forged), null);
});

test('an expired token is refused', async () => {
  const { token } = await mintToken(SECRET, { p: 'central', a: 'acc-1', r: 'manager' }, -1000);
  assert.equal(await readToken(SECRET, token), null);
});

test('malformed tokens return null rather than throwing', async () => {
  for (const bad of ['', 'nonsense', 'a.b.c', '....', 'not-base64!.sig']) {
    assert.equal(await readToken(SECRET, bad), null, JSON.stringify(bad));
  }
});

/* ------------------------------------------------------------------ *
 * The admin boundary
 *
 * The whole super-admin surface rests on one claim. These check that a
 * pharmacy token cannot acquire it and an admin token is distinguishable.
 * ------------------------------------------------------------------ */
test('a manager token does not carry the admin claim', async () => {
  const { token } = await mintToken(SECRET, { p: 'central', a: 'mgr-1', r: 'manager' });
  const claims = await readToken(SECRET, token);
  assert.equal(claims.r, 'manager');
  assert.notEqual(claims.r, 'admin');
});

test('an admin token is not scoped to a pharmacy', async () => {
  const { token } = await mintToken(SECRET, { r: 'admin' });
  const claims = await readToken(SECRET, token);
  assert.equal(claims.r, 'admin');
  assert.equal(claims.p, undefined, 'nothing ties an admin session to one pharmacy');
});

test('promoting a manager token to admin invalidates the signature', async () => {
  const { token } = await mintToken(SECRET, { p: 'central', a: 'mgr-1', r: 'manager' });
  const [payload, sig] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  claims.r = 'admin';
  const forged = Buffer.from(JSON.stringify(claims)).toString('base64url') + '.' + sig;
  assert.equal(await readToken(SECRET, forged), null);
});

/* ------------------------------------------------------------------ *
 * Pharmacy codes
 * ------------------------------------------------------------------ */
test('a pharmacy code is reduced to what Turso will accept as a name', () => {
  assert.equal(normaliseCode('Central Pharmacy'), 'central-pharmacy');
  assert.equal(normaliseCode('  Aïn Benian!! '), 'a-n-benian');
  assert.equal(normaliseCode('CENTRAL'), 'central');
  assert.equal(normaliseCode('--x--'), null, 'too short after cleaning');
  assert.equal(normaliseCode('ab'), null);
  assert.equal(normaliseCode(''), null);
  assert.equal(normaliseCode(null), null);
});

test('a code never exceeds the database-name limit', () => {
  const code = normaliseCode('x'.repeat(200));
  assert.equal(code.length, 48);
  assert.ok(dbNameFor(code).length <= 64, 'pharmacheck- prefix still fits in 64 chars');
});
