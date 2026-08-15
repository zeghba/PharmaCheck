/* =====================================================================
   PharmaCheck sync Worker.

   The app stays local-first: every screen still reads from the copy of
   the data on the device, so the counter works with no signal. This
   Worker is what makes several devices agree on that copy, and it is the
   only place two things can live safely —

     * the Turso platform token, which can create and destroy databases,
     * the authority to decide what a price is.

   The second one is the reason vendor writes come through here rather
   than going straight to Turso. A token that lets a vendor decrement
   `qty` on a sale is, unavoidably, a token that lets them rewrite
   `price` — Turso scopes tokens by table and action, not by column. So
   vendors hold a read-only database path and post sales to `/v1/push`,
   where the server reads the price out of its own row and ignores
   whatever the device claimed it was.
   ===================================================================== */

import { hashPin, randomSalt, safeEqual, mintToken, readToken, SESSION_MS } from './auth.js';
import { provision, resolvePharmacy, connect, normaliseCode } from './turso.js';
import { DbError } from './hrana.js';
import { TursoError } from './turso.js';

const VERSION = '1.0.0';
const MANAGER = 'manager';
const VENDOR = 'vendor';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-setup-key',
  'access-control-max-age': '86400'
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, CORS)
  });
}

function fail(message, status) {
  return json({ ok: false, message: message }, status || 400);
}

/* ------------------------------------------------------------------ *
 * Row shapes — snake_case in SQLite, the app's field names on the wire
 * ------------------------------------------------------------------ */
function medicineOut(r) {
  return {
    name: r.name, strength: r.strength, form: r.form, packaging: r.packaging,
    qty: r.qty, reorder: r.reorder_level, batch: r.batch, expiry: r.expiry,
    price: r.price, cost: r.cost, barcode: r.barcode
  };
}

function accountOut(r) {
  return {
    id: r.id, name: r.name, role: r.role,
    active: r.active === 1, createdAt: r.created_at
  };
}

function saleOut(r) {
  return {
    id: r.id, vendorId: r.vendor_id, vendorName: r.vendor_name,
    medicine: r.medicine, barcode: r.barcode, boxes: r.boxes,
    unitPrice: r.unit_price, unitCost: r.unit_cost, at: r.at, source: r.source
  };
}

function prescriptionOut(r) {
  var items = [];
  try { items = JSON.parse(r.items); } catch (e) { /* keep the record, lose the lines */ }
  return {
    code: r.code, patient: r.patient, prescriber: r.prescriber, items: items,
    status: r.status, createdAt: r.created_at, filledAt: r.filled_at, source: r.source
  };
}

async function snapshot(db, code) {
  var out = await db.pipeline([
    'SELECT * FROM medicines ORDER BY name',
    'SELECT id, name, role, active, created_at FROM accounts ORDER BY created_at',
    'SELECT * FROM sales ORDER BY at',
    'SELECT * FROM prescriptions ORDER BY created_at',
    "SELECT value FROM meta WHERE key = 'seq'"
  ]);

  var seqRow = out[4].rows[0];
  return {
    pharmacy: code,
    medicines: out[0].rows.map(medicineOut),
    accounts: out[1].rows.map(accountOut),
    sales: out[2].rows.map(saleOut),
    prescriptions: out[3].rows.map(prescriptionOut),
    seq: seqRow ? Number(seqRow.value) : 480,
    syncedAt: Date.now()
  };
}

/* ------------------------------------------------------------------ *
 * Sign-in throttling
 *
 * A 4-digit PIN has ten thousand possibilities, which a script exhausts
 * in seconds if nothing stands in the way. This is what stands in the
 * way — it is the reason the PIN is worth anything at all.
 * ------------------------------------------------------------------ */
const MAX_ATTEMPTS = 8;
const LOCKOUT_S = 900;

async function attemptKey(env, code, accountId) {
  return 'attempts:' + code + ':' + accountId;
}

async function checkThrottle(env, code, accountId) {
  var raw = await env.PHARMACIES.get(await attemptKey(env, code, accountId));
  var n = raw ? Number(raw) : 0;
  return n < MAX_ATTEMPTS;
}

async function noteFailure(env, code, accountId) {
  var key = await attemptKey(env, code, accountId);
  var raw = await env.PHARMACIES.get(key);
  var n = (raw ? Number(raw) : 0) + 1;
  await env.PHARMACIES.put(key, String(n), { expirationTtl: LOCKOUT_S });
  return MAX_ATTEMPTS - n;
}

async function clearFailures(env, code, accountId) {
  await env.PHARMACIES.delete(await attemptKey(env, code, accountId));
}

/* ------------------------------------------------------------------ *
 * Mutations
 *
 * Every op is checked against the caller's role here, on the server.
 * The role guard in the app is a UI convenience; this is the boundary.
 * ------------------------------------------------------------------ */
const MANAGER_ONLY = [
  'stock', 'pricing', 'prescription.create', 'prescription.fill',
  'vendor.add', 'vendor.update', 'vendor.remove', 'seed'
];

async function applyOp(db, claims, op) {
  var kind = String(op.op || '');

  if (MANAGER_ONLY.indexOf(kind) !== -1 && claims.r !== MANAGER) {
    return { ok: false, op: kind, message: 'Only a manager can do that' };
  }

  switch (kind) {
    case 'sale':        return applySale(db, claims, op);
    case 'stock':       return applyStock(db, op);
    case 'pricing':     return applyPricing(db, op);
    case 'prescription.create': return applyPrescription(db, op);
    case 'prescription.fill':   return applyFill(db, op);
    case 'vendor.add':    return applyVendorAdd(db, op);
    case 'vendor.update': return applyVendorUpdate(db, op);
    case 'vendor.remove': return applyVendorRemove(db, op);
    case 'seed':          return applySeed(db, op);
    default:
      return { ok: false, op: kind, message: 'Unknown operation' };
  }
}

/* A sale carries a client-generated id. Replaying an outbox after a
   dropped connection therefore cannot bill the same box twice. */
async function applySale(db, claims, op) {
  var id = String(op.id || '');
  if (!id) return { ok: false, op: 'sale', message: 'Sale is missing an id' };

  var seen = await db.one('SELECT id FROM sales WHERE id = ?', [id]);
  if (seen) return { ok: true, op: 'sale', id: id, duplicate: true };

  // A vendor may only file sales under their own name.
  var vendorId = claims.r === MANAGER ? String(op.vendorId || claims.a) : claims.a;

  var vendor = await db.one('SELECT id, name, active FROM accounts WHERE id = ?', [vendorId]);
  if (!vendor) return { ok: false, op: 'sale', message: 'Unknown account' };
  if (vendor.active !== 1) return { ok: false, op: 'sale', message: vendor.name + ' is deactivated' };

  var med = await db.one('SELECT * FROM medicines WHERE name = ?', [String(op.medicine || '')]);
  if (!med) return { ok: false, op: 'sale', message: op.medicine + ' is not stocked here' };

  var boxes = Math.max(1, Math.floor(Number(op.boxes) || 1));
  if (med.qty < boxes) {
    return { ok: false, op: 'sale', message: 'Only ' + med.qty + ' of ' + med.name + ' left' };
  }

  var at = Number(op.at) || Date.now();

  /* The insert is gated on `changes()` from the decrement immediately
     before it, so the two either both happen or neither does — the read
     above is only an early exit, not the check that counts. Another
     device selling the last box between the two is handled here.

     unit_price and unit_cost come from the row, never from the device. */
  var res = await db.tx([
    ['UPDATE medicines SET qty = qty - ?, updated_at = ? WHERE name = ? AND qty >= ?',
     [boxes, Date.now(), med.name, boxes]],
    [`INSERT INTO sales (id, vendor_id, vendor_name, medicine, barcode, boxes, unit_price, unit_cost, at, source)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
     [id, vendor.id, vendor.name, med.name, med.barcode, boxes, med.price, med.cost, at, String(op.source || 'scan')]]
  ]);

  if (!res[1].affected) {
    var now = await db.one('SELECT qty FROM medicines WHERE name = ?', [med.name]);
    return { ok: false, op: 'sale', message: 'Only ' + (now ? now.qty : 0) + ' of ' + med.name + ' left' };
  }

  return { ok: true, op: 'sale', id: id };
}

async function applyStock(db, op) {
  var name = String(op.name || '').trim();
  if (!name) return { ok: false, op: 'stock', message: 'Medicine name is required' };

  var units = Math.floor(Number(op.units) || 0);
  var d = op.details || {};
  var existing = await db.one('SELECT * FROM medicines WHERE name = ?', [name]);

  if (existing) {
    var sets = ['qty = qty + ?', 'updated_at = ?'];
    var args = [units, Date.now()];
    if (d.expiry) { sets.splice(1, 0, 'expiry = ?'); args.splice(1, 0, String(d.expiry)); }
    await db.execute('UPDATE medicines SET ' + sets.join(', ') + ' WHERE name = ?', args.concat([name]));
    return { ok: true, op: 'stock', name: name, created: false };
  }

  var barcode = String(d.barcode || '').trim();
  if (!/^\d{6,14}$/.test(barcode)) {
    return { ok: false, op: 'stock', message: 'A new medicine needs a 6 to 14 digit barcode' };
  }
  var clash = await db.one('SELECT name FROM medicines WHERE barcode = ?', [barcode]);
  if (clash) return { ok: false, op: 'stock', message: 'That barcode already belongs to ' + clash.name };

  var price = Number(d.price), cost = Number(d.cost);
  if (!isFinite(price) || price <= 0) return { ok: false, op: 'stock', message: 'Enter a selling price' };
  if (!isFinite(cost) || cost < 0) return { ok: false, op: 'stock', message: 'Enter a cost' };
  if (cost > price) return { ok: false, op: 'stock', message: 'Cost is higher than the selling price' };

  await db.execute(
    `INSERT INTO medicines (name, strength, form, packaging, qty, reorder_level, batch, expiry, price, cost, barcode, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, String(d.strength || ''), String(d.form || 'comprime'), String(d.packaging || 'boite'),
     units, Math.max(10, Math.round(units / 4)), String(d.batch || ''), String(d.expiry || ''),
     Math.round(price * 100) / 100, Math.round(cost * 100) / 100, barcode, Date.now()]
  );
  return { ok: true, op: 'stock', name: name, created: true };
}

async function applyPricing(db, op) {
  var price = Number(op.price), cost = Number(op.cost);
  if (!isFinite(price) || price < 0) return { ok: false, op: 'pricing', message: 'Enter a valid selling price' };
  if (!isFinite(cost) || cost < 0) return { ok: false, op: 'pricing', message: 'Enter a valid cost' };
  if (cost > price) return { ok: false, op: 'pricing', message: 'Cost is higher than the selling price' };

  var res = await db.execute(
    'UPDATE medicines SET price = ?, cost = ?, updated_at = ? WHERE name = ?',
    [Math.round(price * 100) / 100, Math.round(cost * 100) / 100, Date.now(), String(op.name || '')]
  );
  if (!res.affected) return { ok: false, op: 'pricing', message: 'Not in the catalogue' };
  return { ok: true, op: 'pricing', name: op.name };
}

async function applyPrescription(db, op) {
  var r = op.record || {};
  if (!r.code) return { ok: false, op: 'prescription.create', message: 'Prescription is missing a code' };

  await db.execute(
    `INSERT OR REPLACE INTO prescriptions (code, patient, prescriber, items, status, created_at, filled_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [r.code, String(r.patient || ''), String(r.prescriber || ''), JSON.stringify(r.items || []),
     String(r.status || 'issued'), Number(r.createdAt) || Date.now(), r.filledAt || null, String(r.source || 'manual')]
  );

  if (r.code && String(r.code).indexOf('PC-') === 0) {
    var n = Number(String(r.code).split('-').pop());
    if (isFinite(n)) {
      // The counter only ever moves forward, so an out-of-order push
      // cannot hand the next prescription a code that is already taken.
      await db.execute(
        `INSERT INTO meta (key, value) VALUES ('seq', ?)
         ON CONFLICT(key) DO UPDATE
           SET value = CAST(MAX(CAST(meta.value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)`,
        [String(n)]
      );
    }
  }
  return { ok: true, op: 'prescription.create', code: r.code };
}

/* Dispensing moves stock for every line or none of them, so a
   prescription cannot leave the shelf half-counted. */
async function applyFill(db, op) {
  var code = String(op.code || '');
  var record = await db.one('SELECT * FROM prescriptions WHERE code = ?', [code]);
  if (!record) return { ok: false, op: 'prescription.fill', message: 'No prescription ' + code };
  if (record.status === 'filled') return { ok: true, op: 'prescription.fill', code: code, duplicate: true };

  var items = [];
  try { items = JSON.parse(record.items); } catch (e) { items = []; }

  for (var i = 0; i < items.length; i++) {
    var med = await db.one('SELECT name, qty FROM medicines WHERE name = ?', [items[i].medication]);
    if (!med) return { ok: false, op: 'prescription.fill', message: items[i].medication + ' is not stocked here' };
    if (med.qty < items[i].qty) {
      return { ok: false, op: 'prescription.fill',
               message: 'Only ' + med.qty + ' of ' + med.name + ' left, ' + items[i].qty + ' needed' };
    }
  }

  /* Every line moves or none does. A guarded decrement can still come
     back empty if another device took the last box after the check
     above, and there is no way to abandon a pipeline mid-flight — so a
     shortfall is undone by putting back exactly the lines that applied,
     and the prescription is only marked filled once they all have. */
  var now = Date.now();
  var applied = await db.tx(items.map(function (it) {
    return ['UPDATE medicines SET qty = qty - ?, updated_at = ? WHERE name = ? AND qty >= ?',
            [it.qty, now, it.medication, it.qty]];
  }));

  var short = applied.findIndex(function (r) { return !r.affected; });
  if (short !== -1) {
    var undo = [];
    applied.forEach(function (r, i) {
      if (r.affected) {
        undo.push(['UPDATE medicines SET qty = qty + ?, updated_at = ? WHERE name = ?',
                   [items[i].qty, Date.now(), items[i].medication]]);
      }
    });
    if (undo.length) await db.tx(undo);
    return { ok: false, op: 'prescription.fill',
             message: items[short].medication + ' ran out while dispensing — nothing was moved' };
  }

  await db.execute('UPDATE prescriptions SET status = ?, filled_at = ? WHERE code = ?', ['filled', now, code]);
  return { ok: true, op: 'prescription.fill', code: code };
}

async function applyVendorAdd(db, op) {
  var a = op.account || {};
  var name = String(a.name || '').trim();
  if (!name) return { ok: false, op: 'vendor.add', message: 'Name is required' };
  if (!/^\d{4}$/.test(String(a.pin || ''))) return { ok: false, op: 'vendor.add', message: 'PIN must be 4 digits' };

  var salt = randomSalt();
  var hash = await hashPin(a.pin, salt);

  await db.execute(
    `INSERT OR REPLACE INTO accounts (id, name, role, pin_hash, pin_salt, active, created_at)
     VALUES (?, ?, 'vendor', ?, ?, ?, ?)`,
    [String(a.id || 'acc-' + Date.now().toString(36)), name, hash, salt,
     a.active === false ? 0 : 1, Number(a.createdAt) || Date.now()]
  );
  return { ok: true, op: 'vendor.add', id: a.id };
}

async function applyVendorUpdate(db, op) {
  var account = await db.one('SELECT * FROM accounts WHERE id = ?', [String(op.id || '')]);
  if (!account || account.role !== VENDOR) return { ok: false, op: 'vendor.update', message: 'Not a vendor account' };

  var f = op.fields || {};
  var sets = [], args = [];

  if (f.name !== undefined) {
    var n = String(f.name).trim();
    if (!n) return { ok: false, op: 'vendor.update', message: 'Name is required' };
    sets.push('name = ?'); args.push(n);
  }
  if (f.pin) {
    if (!/^\d{4}$/.test(String(f.pin))) return { ok: false, op: 'vendor.update', message: 'PIN must be 4 digits' };
    var salt = randomSalt();
    sets.push('pin_hash = ?', 'pin_salt = ?');
    args.push(await hashPin(f.pin, salt), salt);
  }
  if (f.active !== undefined) { sets.push('active = ?'); args.push(f.active ? 1 : 0); }
  if (!sets.length) return { ok: true, op: 'vendor.update', id: op.id };

  await db.execute('UPDATE accounts SET ' + sets.join(', ') + ' WHERE id = ?', args.concat([account.id]));
  return { ok: true, op: 'vendor.update', id: account.id };
}

/* A vendor with sales against their name is deactivated rather than
   deleted, so the figures those sales feed stay explainable. */
async function applyVendorRemove(db, op) {
  var id = String(op.id || '');
  var account = await db.one('SELECT * FROM accounts WHERE id = ?', [id]);
  if (!account || account.role !== VENDOR) return { ok: false, op: 'vendor.remove', message: 'Not a vendor account' };

  var sold = await db.one('SELECT COUNT(*) AS n FROM sales WHERE vendor_id = ?', [id]);
  if (sold && sold.n > 0) {
    await db.execute('UPDATE accounts SET active = 0 WHERE id = ?', [id]);
    return { ok: true, op: 'vendor.remove', id: id, deactivated: true };
  }
  await db.execute('DELETE FROM accounts WHERE id = ?', [id]);
  return { ok: true, op: 'vendor.remove', id: id, deactivated: false };
}

/* First sync of a device that has been running locally: push what is
   already on it up. Only into an empty catalogue — a second device
   arriving later pulls instead, so two histories never interleave. */
async function applySeed(db, op) {
  var count = await db.one('SELECT COUNT(*) AS n FROM medicines');
  if (count && count.n > 0) {
    return { ok: false, op: 'seed', message: 'This pharmacy already has stock — pull instead of seeding' };
  }

  var now = Date.now();
  var stmts = [];

  (op.medicines || []).forEach(function (m) {
    stmts.push([
      `INSERT OR REPLACE INTO medicines (name, strength, form, packaging, qty, reorder_level, batch, expiry, price, cost, barcode, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [m.name, m.strength || '', m.form || 'comprime', m.packaging || 'boite',
       Number(m.qty) || 0, Number(m.reorder) || 0, m.batch || '', m.expiry || '',
       Number(m.price) || 0, Number(m.cost) || 0, m.barcode || '', now]
    ]);
  });

  (op.sales || []).forEach(function (s) {
    stmts.push([
      `INSERT OR IGNORE INTO sales (id, vendor_id, vendor_name, medicine, barcode, boxes, unit_price, unit_cost, at, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [s.id, s.vendorId, s.vendorName || '', s.medicine, s.barcode || '',
       Number(s.boxes) || 1, Number(s.unitPrice) || 0, Number(s.unitCost) || 0,
       Number(s.at) || now, s.source || 'scan']
    ]);
  });

  (op.prescriptions || []).forEach(function (p) {
    stmts.push([
      `INSERT OR IGNORE INTO prescriptions (code, patient, prescriber, items, status, created_at, filled_at, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.code, p.patient || '', p.prescriber || '', JSON.stringify(p.items || []),
       p.status || 'issued', Number(p.createdAt) || now, p.filledAt || null, p.source || 'manual']
    ]);
  });

  if (op.seq) {
    stmts.push([`INSERT OR REPLACE INTO meta (key, value) VALUES ('seq', ?)`, [String(op.seq)]]);
  }

  // Turso caps how much one pipeline may carry, so a four-month history
  // goes up in chunks rather than as one enormous request.
  for (var i = 0; i < stmts.length; i += 200) {
    await db.tx(stmts.slice(i, i + 200));
  }

  return { ok: true, op: 'seed', medicines: (op.medicines || []).length,
           sales: (op.sales || []).length, prescriptions: (op.prescriptions || []).length };
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */
async function authed(env, request) {
  var header = request.headers.get('authorization') || '';
  var token = header.replace(/^Bearer\s+/i, '');
  var claims = await readToken(env.SESSION_SECRET, token);
  if (!claims) return null;

  var entry = await resolvePharmacy(env, claims.p);
  if (!entry) return null;

  return { claims: claims, entry: entry, db: connect(entry) };
}

async function handle(request, env) {
  var url = new URL(request.url);
  var path = url.pathname.replace(/\/+$/, '') || '/';

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  /* -------- health: what is configured, without leaking any of it ---- */
  if (path === '/v1/health' || path === '/') {
    return json({
      ok: true,
      service: 'pharmacheck-sync',
      version: VERSION,
      configured: {
        platformToken: Boolean(env.TURSO_PLATFORM_TOKEN),
        org: Boolean(env.TURSO_ORG),
        group: env.TURSO_GROUP || 'default',
        sessionSecret: Boolean(env.SESSION_SECRET),
        setupKey: Boolean(env.SETUP_KEY),
        kv: Boolean(env.PHARMACIES)
      }
    });
  }

  /* -------- provision a pharmacy ------------------------------------ */
  if (path === '/v1/pharmacy' && request.method === 'POST') {
    if (!env.SETUP_KEY) return fail('This Worker has no SETUP_KEY set — run: wrangler secret put SETUP_KEY', 503);
    if (!safeEqual(request.headers.get('x-setup-key') || '', env.SETUP_KEY)) {
      return fail('Wrong setup key', 401);
    }
    if (!env.TURSO_PLATFORM_TOKEN || !env.TURSO_ORG) {
      return fail('This Worker has no Turso credentials — set TURSO_PLATFORM_TOKEN and TURSO_ORG', 503);
    }

    var body = await request.json().catch(function () { return {}; });
    var code = normaliseCode(body.pharmacy);
    if (!code) return fail('Pharmacy code must be at least 3 letters, digits or dashes');
    if (!/^\d{4}$/.test(String(body.managerPin || ''))) return fail('Manager PIN must be 4 digits');

    var made = await provision(env, code);
    var db = connect(made.entry);

    var managerId = String(body.managerId || 'acc-1');
    var salt = randomSalt();
    var hash = await hashPin(body.managerPin, salt);

    await db.execute(
      `INSERT OR REPLACE INTO accounts (id, name, role, pin_hash, pin_salt, active, created_at)
       VALUES (?, ?, 'manager', ?, ?, 1, ?)`,
      [managerId, String(body.managerName || 'Manager'), hash, salt, Date.now()]
    );

    var stock = await db.one('SELECT COUNT(*) AS n FROM medicines');
    return json({
      ok: true,
      pharmacy: code,
      created: made.created,
      database: made.entry.dbName,
      empty: !stock || stock.n === 0,
      managerId: managerId
    });
  }

  /* -------- who can sign in here ------------------------------------
     Names only, and only for a caller who already knows the pharmacy
     code. The sign-in picker needs this before anyone has a token. */
  if (path === '/v1/accounts' && request.method === 'GET') {
    var code2 = normaliseCode(url.searchParams.get('pharmacy'));
    if (!code2) return fail('Missing pharmacy code');
    var entry2 = await resolvePharmacy(env, code2);
    if (!entry2) return fail('No pharmacy with that code', 404);

    var rows = await connect(entry2).all(
      'SELECT id, name, role, active, created_at FROM accounts WHERE active = 1 ORDER BY role, created_at'
    );
    return json({ ok: true, pharmacy: code2, accounts: rows.map(accountOut) });
  }

  /* -------- sign in -------------------------------------------------- */
  if (path === '/v1/signin' && request.method === 'POST') {
    if (!env.SESSION_SECRET) return fail('This Worker has no SESSION_SECRET set', 503);

    var creds = await request.json().catch(function () { return {}; });
    var code3 = normaliseCode(creds.pharmacy);
    if (!code3) return fail('Missing pharmacy code');

    var entry3 = await resolvePharmacy(env, code3);
    if (!entry3) return fail('No pharmacy with that code', 404);

    var accountId = String(creds.accountId || '');
    if (!await checkThrottle(env, code3, accountId)) {
      return fail('Too many wrong PINs — try again in 15 minutes', 429);
    }

    var db3 = connect(entry3);
    var account = await db3.one('SELECT * FROM accounts WHERE id = ?', [accountId]);
    if (!account) { await noteFailure(env, code3, accountId); return fail('No such account', 401); }
    if (account.active !== 1) return fail(account.name + ' is deactivated', 403);

    var given = await hashPin(String(creds.pin || ''), account.pin_salt);
    if (!safeEqual(given, account.pin_hash)) {
      var left = await noteFailure(env, code3, accountId);
      return fail(left > 0 ? 'Incorrect PIN — ' + left + ' attempts left' : 'Too many wrong PINs', 401);
    }

    await clearFailures(env, code3, accountId);
    var minted = await mintToken(env.SESSION_SECRET, { p: code3, a: account.id, r: account.role }, SESSION_MS);

    return json({
      ok: true,
      token: minted.token,
      expiresAt: minted.expiresAt,
      account: accountOut(account),
      snapshot: await snapshot(db3, code3)
    });
  }

  /* -------- pull ----------------------------------------------------- */
  if (path === '/v1/pull' && request.method === 'POST') {
    var s1 = await authed(env, request);
    if (!s1) return fail('Sign in again', 401);
    return json({ ok: true, snapshot: await snapshot(s1.db, s1.claims.p) });
  }

  /* -------- push ----------------------------------------------------- */
  if (path === '/v1/push' && request.method === 'POST') {
    var s2 = await authed(env, request);
    if (!s2) return fail('Sign in again', 401);

    var payload = await request.json().catch(function () { return {}; });
    var ops = Array.isArray(payload.ops) ? payload.ops : [];
    if (ops.length > 500) return fail('Too many operations in one push', 413);

    var results = [];
    for (var i = 0; i < ops.length; i++) {
      try {
        results.push(await applyOp(s2.db, s2.claims, ops[i]));
      } catch (e) {
        results.push({ ok: false, op: ops[i] && ops[i].op, message: e.message });
      }
    }

    return json({
      ok: results.every(function (r) { return r.ok; }),
      results: results,
      snapshot: await snapshot(s2.db, s2.claims.p)
    });
  }

  return fail('No route for ' + request.method + ' ' + path, 404);
}

export default {
  async fetch(request, env) {
    try {
      if (!env.PHARMACIES) {
        return fail('This Worker has no KV namespace bound — see worker/README.md', 503);
      }
      return await handle(request, env);
    } catch (e) {
      var status = (e instanceof DbError || e instanceof TursoError) ? e.status : 500;
      return fail(e && e.message ? e.message : 'Unexpected error', status);
    }
  }
};
