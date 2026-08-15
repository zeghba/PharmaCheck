/* =====================================================================
   Super-admin API.

   Everything here is above a single pharmacy: creating them, listing
   them, and managing who can sign in to each one. It is the surface the
   admin app talks to, and nothing in the pharmacy app can reach it —
   an admin session is minted from SETUP_KEY, which only the operator
   holds, and carries role 'admin', which no pharmacy sign-in can issue.

   Managers and vendors are created here rather than inside a pharmacy,
   so the person handing out a phone is the person who decides what that
   phone may do.
   ===================================================================== */

import { hashPin, randomSalt, safeEqual, mintToken } from './auth.js';
import { provision, resolvePharmacy, connect, normaliseCode, dbNameFor, forgetPharmacy } from './turso.js';

const ADMIN_TTL = 8 * 60 * 60 * 1000;   // a working day, not a shift

const MANAGER = 'manager';
const VENDOR = 'vendor';
const CONFIG_KEY = 'config:turso';

/* ------------------------------------------------------------------ *
 * Turso configuration
 *
 * There are two ways to give this Worker its Turso credentials, and
 * they are not equally safe:
 *
 *   wrangler secret put   the token goes from your machine to
 *                         Cloudflare and never touches a phone
 *   the admin app         the token is typed on a handset and posted
 *                         here, so it crosses one device once
 *
 * A secret set with wrangler always wins, so configuring it properly
 * later silently retires whatever the app stored. The admin Settings
 * screen shows which of the two is in force rather than leaving the
 * operator to guess.
 * ------------------------------------------------------------------ */
export async function storedConfig(env) {
  try {
    var raw = await env.PHARMACIES.get(CONFIG_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

/* Everything downstream reads org, group and token off `env`, so the
   merge happens once, here, rather than at each use. */
export async function resolveEnv(env) {
  var stored = await storedConfig(env);
  return Object.assign({}, env, {
    TURSO_ORG: env.TURSO_ORG || stored.org || '',
    TURSO_GROUP: env.TURSO_GROUP || stored.group || 'default',
    TURSO_PLATFORM_TOKEN: env.TURSO_PLATFORM_TOKEN || stored.token || ''
  });
}

export async function configStatus(env) {
  var stored = await storedConfig(env);
  var source = function (fromEnv, fromStore) {
    if (fromEnv) return 'worker-secret';
    if (fromStore) return 'admin-app';
    return null;
  };

  return {
    org: {
      value: env.TURSO_ORG || stored.org || '',
      source: source(env.TURSO_ORG, stored.org)
    },
    group: {
      value: env.TURSO_GROUP || stored.group || 'default',
      source: source(env.TURSO_GROUP, stored.group)
    },
    // The token itself is never sent back — only whether one exists.
    platformToken: {
      set: Boolean(env.TURSO_PLATFORM_TOKEN || stored.token),
      source: source(env.TURSO_PLATFORM_TOKEN, stored.token)
    },
    sessionSecret: { set: Boolean(env.SESSION_SECRET), source: env.SESSION_SECRET ? 'worker-secret' : null },
    setupKey: { set: Boolean(env.SETUP_KEY), source: env.SETUP_KEY ? 'worker-secret' : null },
    kv: { set: Boolean(env.PHARMACIES) }
  };
}

export async function putConfig(env, fields) {
  var stored = await storedConfig(env);
  var next = Object.assign({}, stored);

  if (fields.org !== undefined) next.org = String(fields.org).trim();
  if (fields.group !== undefined) next.group = String(fields.group).trim() || 'default';
  // An empty string clears the stored token; undefined leaves it alone.
  if (fields.token !== undefined) {
    var t = String(fields.token).trim();
    if (t) next.token = t; else delete next.token;
  }
  next.updatedAt = Date.now();

  await env.PHARMACIES.put(CONFIG_KEY, JSON.stringify(next));
  return { ok: true, config: await configStatus(env) };
}

/* Confirms the credentials actually work before a pharmacy is created
   against them, so a wrong token is a clear message here rather than a
   confusing failure halfway through provisioning. */
export async function testTurso(env) {
  var resolved = await resolveEnv(env);
  if (!resolved.TURSO_PLATFORM_TOKEN) return { ok: false, message: 'No Turso platform token is set' };
  if (!resolved.TURSO_ORG) return { ok: false, message: 'No Turso organisation is set' };

  var res = await fetch('https://api.turso.tech/v1/organizations/' + resolved.TURSO_ORG + '/groups', {
    headers: { authorization: 'Bearer ' + resolved.TURSO_PLATFORM_TOKEN }
  });

  if (res.status === 401) return { ok: false, message: 'Turso rejected the platform token' };
  if (res.status === 404) return { ok: false, message: 'No Turso organisation called “' + resolved.TURSO_ORG + '”' };
  if (!res.ok) return { ok: false, message: 'Turso returned ' + res.status };

  var body = await res.json();
  var groups = (body.groups || []).map(function (g) { return g.name; });
  var wanted = resolved.TURSO_GROUP || 'default';

  return {
    ok: groups.indexOf(wanted) !== -1,
    groups: groups,
    group: wanted,
    message: groups.indexOf(wanted) !== -1
      ? 'Connected to ' + resolved.TURSO_ORG + ' · group “' + wanted + '”'
      : 'Connected, but there is no group called “' + wanted + '”. Available: ' + (groups.join(', ') || 'none')
  };
}

/* ------------------------------------------------------------------ *
 * Listing
 *
 * KV is the index of which pharmacies exist. Reading each one's
 * database for counts would be one round trip per pharmacy, so the list
 * stays cheap and the detail view is where the numbers come from.
 * ------------------------------------------------------------------ */
export async function listPharmacies(env) {
  var out = [];
  var cursor = undefined;

  do {
    var page = await env.PHARMACIES.list({ prefix: 'pharmacy:', cursor: cursor });
    for (var i = 0; i < page.keys.length; i++) {
      var raw = await env.PHARMACIES.get(page.keys[i].name);
      if (!raw) continue;
      try {
        var entry = JSON.parse(raw);
        out.push({
          code: entry.code,
          database: entry.dbName,
          createdAt: entry.createdAt || null
        });
      } catch (e) { /* a corrupt entry should not hide the rest */ }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);

  return out.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
}

/* One pharmacy in full: who can sign in, and enough figures to tell a
   busy pharmacy from an abandoned one. */
export async function pharmacyDetail(env, code) {
  var entry = await resolvePharmacy(env, code);
  if (!entry) return null;

  var db = connect(entry);
  var out = await db.pipeline([
    'SELECT id, name, role, active, created_at FROM accounts ORDER BY role, created_at',
    'SELECT COUNT(*) AS n, COALESCE(SUM(qty), 0) AS units FROM medicines',
    'SELECT COUNT(*) AS n, COALESCE(SUM(unit_price * boxes), 0) AS revenue FROM sales',
    'SELECT COUNT(*) AS n FROM prescriptions',
    'SELECT MAX(at) AS last FROM sales'
  ]);

  var accounts = out[0].rows.map(function (r) {
    return { id: r.id, name: r.name, role: r.role, active: r.active === 1, createdAt: r.created_at };
  });

  return {
    code: entry.code,
    database: entry.dbName,
    createdAt: entry.createdAt || null,
    accounts: accounts,
    managers: accounts.filter(function (a) { return a.role === MANAGER; }).length,
    vendors: accounts.filter(function (a) { return a.role === VENDOR; }).length,
    medicines: out[1].rows[0].n,
    units: out[1].rows[0].units,
    sales: out[2].rows[0].n,
    revenue: out[2].rows[0].revenue,
    prescriptions: out[3].rows[0].n,
    lastSaleAt: out[4].rows[0].last || null
  };
}

/* The dashboard's top line. Every pharmacy is queried, so this is the
   one call that costs as much as the estate is large — the admin app
   asks for it on the dashboard and nowhere else. */
export async function overview(env) {
  var list = await listPharmacies(env);
  var totals = { pharmacies: list.length, accounts: 0, vendors: 0, medicines: 0, sales: 0, revenue: 0 };
  var rows = [];

  for (var i = 0; i < list.length; i++) {
    try {
      var detail = await pharmacyDetail(env, list[i].code);
      if (!detail) continue;
      totals.accounts += detail.accounts.length;
      totals.vendors += detail.vendors;
      totals.medicines += detail.medicines;
      totals.sales += detail.sales;
      totals.revenue += detail.revenue;
      rows.push({
        code: detail.code, createdAt: detail.createdAt,
        managers: detail.managers, vendors: detail.vendors,
        medicines: detail.medicines, sales: detail.sales,
        revenue: detail.revenue, lastSaleAt: detail.lastSaleAt,
        reachable: true
      });
    } catch (e) {
      // A pharmacy whose database is unreachable still belongs on the
      // list — hiding it would make a broken one look like no one's.
      rows.push({ code: list[i].code, createdAt: list[i].createdAt, reachable: false, error: e.message });
    }
  }

  return { totals: totals, pharmacies: rows };
}

/* ------------------------------------------------------------------ *
 * Accounts
 * ------------------------------------------------------------------ */
export async function createAccount(env, code, fields) {
  var entry = await resolvePharmacy(env, code);
  if (!entry) return { ok: false, message: 'No pharmacy with that code', status: 404 };

  var name = String(fields.name || '').trim();
  var role = fields.role === MANAGER ? MANAGER : VENDOR;
  if (!name) return { ok: false, message: 'Name is required' };
  if (!/^\d{4}$/.test(String(fields.pin || ''))) return { ok: false, message: 'PIN must be 4 digits' };

  var db = connect(entry);
  var id = String(fields.id || '').trim() ||
           (role === MANAGER ? 'mgr-' : 'acc-') + Date.now().toString(36);

  var clash = await db.one('SELECT id FROM accounts WHERE id = ?', [id]);
  if (clash) return { ok: false, message: 'An account with that id already exists' };

  var salt = randomSalt();
  var hash = await hashPin(fields.pin, salt);

  await db.execute(
    `INSERT INTO accounts (id, name, role, pin_hash, pin_salt, active, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
    [id, name, role, hash, salt, Date.now()]
  );

  return { ok: true, account: { id: id, name: name, role: role, active: true, createdAt: Date.now() } };
}

export async function updateAccount(env, code, id, fields) {
  var entry = await resolvePharmacy(env, code);
  if (!entry) return { ok: false, message: 'No pharmacy with that code', status: 404 };

  var db = connect(entry);
  var account = await db.one('SELECT * FROM accounts WHERE id = ?', [id]);
  if (!account) return { ok: false, message: 'No such account', status: 404 };

  var sets = [], args = [];

  if (fields.name !== undefined) {
    var n = String(fields.name).trim();
    if (!n) return { ok: false, message: 'Name is required' };
    sets.push('name = ?'); args.push(n);
  }
  if (fields.pin) {
    if (!/^\d{4}$/.test(String(fields.pin))) return { ok: false, message: 'PIN must be 4 digits' };
    var salt = randomSalt();
    sets.push('pin_hash = ?', 'pin_salt = ?');
    args.push(await hashPin(fields.pin, salt), salt);
  }
  if (fields.active !== undefined) { sets.push('active = ?'); args.push(fields.active ? 1 : 0); }

  /* A pharmacy with no active manager cannot be administered from a
     phone again, so the last one is not allowed to switch itself off. */
  if (fields.active === false && account.role === MANAGER) {
    var others = await db.one(
      "SELECT COUNT(*) AS n FROM accounts WHERE role = 'manager' AND active = 1 AND id <> ?", [id]
    );
    if (!others || others.n === 0) {
      return { ok: false, message: 'This is the only active manager — add another one first' };
    }
  }

  if (!sets.length) return { ok: true, account: { id: id } };

  await db.execute('UPDATE accounts SET ' + sets.join(', ') + ' WHERE id = ?', args.concat([id]));
  var fresh = await db.one('SELECT id, name, role, active, created_at FROM accounts WHERE id = ?', [id]);
  return {
    ok: true,
    account: { id: fresh.id, name: fresh.name, role: fresh.role, active: fresh.active === 1, createdAt: fresh.created_at }
  };
}

/* An account with sales against its name is deactivated rather than
   deleted, so the figures those sales feed stay explainable. */
export async function removeAccount(env, code, id) {
  var entry = await resolvePharmacy(env, code);
  if (!entry) return { ok: false, message: 'No pharmacy with that code', status: 404 };

  var db = connect(entry);
  var account = await db.one('SELECT * FROM accounts WHERE id = ?', [id]);
  if (!account) return { ok: false, message: 'No such account', status: 404 };

  if (account.role === MANAGER) {
    var others = await db.one(
      "SELECT COUNT(*) AS n FROM accounts WHERE role = 'manager' AND active = 1 AND id <> ?", [id]
    );
    if (!others || others.n === 0) {
      return { ok: false, message: 'This is the only active manager — add another one first' };
    }
  }

  var sold = await db.one('SELECT COUNT(*) AS n FROM sales WHERE vendor_id = ?', [id]);
  if (sold && sold.n > 0) {
    await db.execute('UPDATE accounts SET active = 0 WHERE id = ?', [id]);
    return { ok: true, deactivated: true, message: account.name + ' has sales on record — deactivated instead of deleted' };
  }

  await db.execute('DELETE FROM accounts WHERE id = ?', [id]);
  return { ok: true, deactivated: false, message: account.name + ' removed' };
}

/* ------------------------------------------------------------------ *
 * Pharmacies
 * ------------------------------------------------------------------ */
export async function createPharmacy(env, fields) {
  var code = normaliseCode(fields.code);
  if (!code) return { ok: false, message: 'The code needs at least 3 letters, digits or dashes' };

  var already = await resolvePharmacy(env, code);
  if (already) return { ok: false, message: 'A pharmacy with the code “' + code + '” already exists' };

  if (!String(fields.managerName || '').trim()) return { ok: false, message: 'The manager needs a name' };
  if (!/^\d{4}$/.test(String(fields.managerPin || ''))) return { ok: false, message: 'The manager PIN must be 4 digits' };

  var made = await provision(env, code);
  var db = connect(made.entry);

  var salt = randomSalt();
  var hash = await hashPin(fields.managerPin, salt);
  var managerId = 'mgr-' + Date.now().toString(36);

  await db.execute(
    `INSERT INTO accounts (id, name, role, pin_hash, pin_salt, active, created_at)
     VALUES (?, ?, 'manager', ?, ?, 1, ?)`,
    [managerId, String(fields.managerName).trim(), hash, salt, Date.now()]
  );

  if (fields.label) {
    await db.execute(
      `INSERT OR REPLACE INTO meta (key, value) VALUES ('label', ?)`, [String(fields.label)]
    );
  }

  return {
    ok: true,
    pharmacy: { code: code, database: dbNameFor(code), createdAt: made.entry.createdAt },
    manager: { id: managerId, name: String(fields.managerName).trim(), role: MANAGER }
  };
}

/* Archiving drops the pharmacy from the index, so devices can no longer
   resolve it, but leaves the database alone — the records outlive the
   decision to stop using them. Destroying the data is a separate,
   explicit act. */
export async function archivePharmacy(env, code, dropDatabase) {
  var entry = await resolvePharmacy(env, code);
  if (!entry) return { ok: false, message: 'No pharmacy with that code', status: 404 };

  await env.PHARMACIES.delete('pharmacy:' + code);
  forgetPharmacy(code);

  if (dropDatabase) {
    var res = await fetch(
      'https://api.turso.tech/v1/organizations/' + env.TURSO_ORG + '/databases/' + entry.dbName,
      { method: 'DELETE', headers: { authorization: 'Bearer ' + env.TURSO_PLATFORM_TOKEN } }
    );
    if (!res.ok && res.status !== 404) {
      return { ok: false, message: 'Removed from the index, but the database could not be deleted (' + res.status + ')' };
    }
    return { ok: true, dropped: true, message: 'Pharmacy “' + code + '” and its database were deleted' };
  }

  return { ok: true, dropped: false, message: 'Pharmacy “' + code + '” archived — its database was kept' };
}

/* ------------------------------------------------------------------ *
 * Admin sessions
 * ------------------------------------------------------------------ */
export async function adminSignIn(env, setupKey) {
  if (!env.SETUP_KEY) return { ok: false, message: 'This Worker has no SETUP_KEY set', status: 503 };
  if (!env.SESSION_SECRET) return { ok: false, message: 'This Worker has no SESSION_SECRET set', status: 503 };
  if (!safeEqual(String(setupKey || ''), env.SETUP_KEY)) {
    return { ok: false, message: 'Wrong setup key', status: 401 };
  }

  var minted = await mintToken(env.SESSION_SECRET, { r: 'admin' }, ADMIN_TTL);
  return { ok: true, token: minted.token, expiresAt: minted.expiresAt };
}

export { ADMIN_TTL };
