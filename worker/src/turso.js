/* =====================================================================
   Turso Platform API — the part that creates databases.

   This is the only place the platform token is used, and the platform
   token is the one credential that must never leave the Worker: it can
   create and destroy every database in the organisation. Devices get
   database-scoped tokens instead, minted here and handed out per
   pharmacy.
   ===================================================================== */

import { Db } from './hrana.js';
import { SCHEMA } from './schema.js';

const API = 'https://api.turso.tech/v1';

export class TursoError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'TursoError';
    this.status = status || 502;
  }
}

async function api(env, path, init) {
  var res = await fetch(API + '/organizations/' + env.TURSO_ORG + path, Object.assign({
    headers: {
      'authorization': 'Bearer ' + env.TURSO_PLATFORM_TOKEN,
      'content-type': 'application/json'
    }
  }, init || {}));

  var text = await res.text();
  var body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }

  if (!res.ok) {
    throw new TursoError(
      (body && (body.error || body.message)) || text.slice(0, 300) || ('Turso returned ' + res.status),
      res.status
    );
  }
  return body;
}

export function dbNameFor(code) {
  return 'pharmacheck-' + String(code).toLowerCase();
}

/* A pharmacy code is a database name suffix, so it has to survive Turso's
   naming rules: lowercase letters, digits and dashes. */
export function normaliseCode(raw) {
  var code = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (code.length < 3) return null;
  return code.slice(0, 48);
}

export async function createDatabase(env, code) {
  return api(env, '/databases', {
    method: 'POST',
    body: JSON.stringify({ name: dbNameFor(code), group: env.TURSO_GROUP || 'default' })
  });
}

export async function getDatabase(env, code) {
  return api(env, '/databases/' + dbNameFor(code), { method: 'GET' });
}

export async function mintDbToken(env, code, authorization, expiration) {
  var query = '?authorization=' + (authorization || 'full-access') +
              (expiration ? '&expiration=' + expiration : '');
  var body = await api(env, '/databases/' + dbNameFor(code) + '/auth/tokens' + query, { method: 'POST' });
  return body.jwt;
}

/* Isolates are short-lived and KV reads cost a round trip, so resolved
   pharmacies are held in the isolate for as long as it happens to live. */
const memo = new Map();

export async function resolvePharmacy(env, code) {
  if (memo.has(code)) return memo.get(code);

  var raw = await env.PHARMACIES.get('pharmacy:' + code);
  if (!raw) return null;

  var entry = JSON.parse(raw);
  memo.set(code, entry);
  return entry;
}

export async function rememberPharmacy(env, code, entry) {
  memo.set(code, entry);
  await env.PHARMACIES.put('pharmacy:' + code, JSON.stringify(entry));
}

/* Archiving has to reach the memo as well as KV. Without this, an isolate
   that had already resolved the pharmacy would keep serving it from
   memory — devices would go on syncing to a pharmacy that was removed,
   for as long as that isolate happened to live. */
export function forgetPharmacy(code) {
  memo.delete(code);
}

export function connect(entry) {
  return new Db(entry.hostname, entry.token);
}

/* Creating a pharmacy is create-database, then mint a token, then apply
   the schema. The schema runs on every provision because CREATE TABLE IF
   NOT EXISTS makes it idempotent — which is what lets a half-finished
   provision be fixed by running it again. */
export async function provision(env, code) {
  var existing = await resolvePharmacy(env, code);
  if (existing) return { entry: existing, created: false };

  var hostname;
  try {
    var made = await createDatabase(env, code);
    hostname = made.database.Hostname;
  } catch (e) {
    // A database left behind by an interrupted provision is not a clash
    // worth surfacing — adopt it.
    if (e.status !== 409) throw e;
    var found = await getDatabase(env, code);
    hostname = found.database.Hostname;
  }

  var token = await mintDbToken(env, code, 'full-access');
  var entry = { code: code, dbName: dbNameFor(code), hostname: hostname, token: token, createdAt: Date.now() };

  var db = connect(entry);
  await db.pipeline(SCHEMA);

  await rememberPharmacy(env, code, entry);
  return { entry: entry, created: true };
}
