/* =====================================================================
   PharmaCheck — cloud sync

   The app is local-first and stays that way: every screen reads the copy
   of the data on this device, so the counter works with no signal. This
   file is what makes several devices agree on that copy.

   Two modes, set on the Connect screen:

     off      Nothing leaves the phone. The default, and the whole app
              still works.

     worker   Through the Cloudflare Worker in worker/. The Turso platform
              token lives there, not here, and the Worker re-reads prices
              from its own rows when a sale lands — so a vendor's device
              cannot decide what a box was worth.

   All this phone stores is the address it syncs to, the pharmacy code and
   a session token. Creating pharmacies, managing accounts and configuring
   the database belong to the separate admin app, which is the only thing
   that holds the credentials for any of that.
   ===================================================================== */
(function (global) {
  'use strict';

  var Store = global.PharmaStore;
  var KEY = 'pharmacheck.cloud.v1';
  var TIMEOUT = 20000;

  var OFF = 'off', WORKER = 'worker';

  var cfg = null;
  var syncing = false;
  var listeners = [];

  function defaults() {
    return {
      mode: OFF,
      workerUrl: '',
      pharmacy: '',
      accountId: null,
      token: null,
      tokenExp: 0,
      lastSync: null,
      lastError: null
    };
  }

  function config() {
    if (cfg) return cfg;
    try {
      var raw = global.localStorage && global.localStorage.getItem(KEY);
      cfg = raw ? Object.assign(defaults(), JSON.parse(raw)) : defaults();
    } catch (e) {
      cfg = defaults();
    }
    Store.setSyncEnabled(cfg.mode !== OFF);
    return cfg;
  }

  function persist() {
    try {
      if (global.localStorage) global.localStorage.setItem(KEY, JSON.stringify(cfg));
    } catch (e) { /* private mode — the settings just will not survive a restart */ }
    announce();
  }

  function configure(patch) {
    config();
    Object.keys(patch || {}).forEach(function (k) {
      cfg[k] = patch[k];
    });
    if (cfg.workerUrl) cfg.workerUrl = String(cfg.workerUrl).trim().replace(/\/+$/, '');
    Store.setSyncEnabled(cfg.mode !== OFF);
    persist();
    return cfg;
  }

  function onChange(fn) { listeners.push(fn); }
  function announce() {
    listeners.forEach(function (fn) {
      try { fn(status()); } catch (e) { /* a bad listener must not break a sync */ }
    });
  }

  function signedIn() {
    var c = config();
    return Boolean(c.token && c.tokenExp > Date.now());
  }

  function status() {
    var c = config();
    return {
      mode: c.mode,
      connected: c.mode !== OFF && Boolean(c.lastSync),
      signedIn: signedIn(),
      pharmacy: c.pharmacy,
      workerUrl: c.workerUrl,
      pending: Store.pendingCount(),
      lastSync: c.lastSync,
      lastError: c.lastError,
      syncing: syncing
    };
  }

  /* ------------------------------------------------------------------ *
   * HTTP
   *
   * A pharmacy counter on a phone loses signal constantly. Every call
   * gives up after 20 seconds rather than leaving a spinner on screen
   * forever, and every failure comes back as a message worth showing.
   * ------------------------------------------------------------------ */
  function request(url, opts) {
    var o = opts || {};
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, o.timeout || TIMEOUT);
    var done = function (value) { clearTimeout(timer); return value; };

    return fetch(url, {
      method: o.method || 'GET',
      headers: o.headers || {},
      body: o.body,
      signal: controller ? controller.signal : undefined
    }).then(function (res) {
      return res.text().then(function (text) {
        var body = null;
        try { body = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
        if (!res.ok) {
          var err = new Error((body && body.message) || text.slice(0, 200) || ('Server returned ' + res.status));
          err.status = res.status;
          throw err;
        }
        return done(body);
      });
    }, function (e) {
      done();
      if (e.name === 'AbortError') throw new Error('The server did not answer in time');
      if (e instanceof TypeError) throw new Error('Could not reach the server — check the URL and the connection');
      throw e;
    }).catch(function (e) {
      done();
      throw e;
    });
  }

  function workerCall(path, opts) {
    var c = config();
    if (!c.workerUrl) return Promise.reject(new Error('No Worker URL set'));
    var o = opts || {};
    var headers = Object.assign({ 'content-type': 'application/json' }, o.headers || {});
    if (o.auth !== false && c.token) headers.authorization = 'Bearer ' + c.token;
    return request(c.workerUrl + path, {
      method: o.method || 'GET',
      headers: headers,
      body: o.body ? JSON.stringify(o.body) : undefined,
      timeout: o.timeout
    });
  }

  /* ------------------------------------------------------------------ *
   * Worker mode
   * ------------------------------------------------------------------ */
  function health(url) {
    var target = (url || config().workerUrl || '').trim().replace(/\/+$/, '');
    if (!target) return Promise.reject(new Error('Enter the Worker URL first'));
    return request(target + '/v1/health', { timeout: 10000 });
  }

  function listAccounts(pharmacy) {
    return workerCall('/v1/accounts?pharmacy=' + encodeURIComponent(pharmacy || config().pharmacy), { auth: false })
      .then(function (body) { return body.accounts || []; });
  }

  /* Sign-in is the Worker's job in worker mode: the PIN is checked against
     a hash the device never sees, and what comes back is a token scoped to
     one account and one role. */
  function signIn(accountId, pin) {
    var c = config();
    return workerCall('/v1/signin', {
      method: 'POST',
      auth: false,
      body: { pharmacy: c.pharmacy, accountId: accountId, pin: String(pin) }
    }).then(function (body) {
      configure({
        accountId: body.account.id,
        token: body.token,
        tokenExp: body.expiresAt,
        lastError: null
      });
      if (body.snapshot) {
        Store.hydrate(body.snapshot);
        cfg.lastSync = body.snapshot.syncedAt;
        persist();
      }
      Store.adoptSession(body.account.id, body.account);
      return { ok: true, account: body.account };
    });
  }

  function signOut() {
    configure({ token: null, tokenExp: 0, accountId: null });
  }

  /* Push before pull, always. The ops in the outbox have already been
     applied to the local copy; hydrating from a snapshot that predates them
     would make a sale made offline vanish off the screen until the next
     round. */
  function workerSync() {
    var ops = Store.outbox();

    var first = ops.length
      ? workerCall('/v1/push', { method: 'POST', body: { ops: ops.map(stripLocal) } })
      : workerCall('/v1/pull', { method: 'POST' });

    return first.then(function (body) {
      if (body.results) {
        var applied = [], refused = [];
        body.results.forEach(function (r, i) {
          if (r.ok) applied.push(ops[i]._id);
          else refused.push({ id: ops[i]._id, op: ops[i].op, message: r.message });
        });

        /* An op the server refused is not a network problem and retrying
           will not change the answer, so it leaves the outbox too — but its
           reason is kept, because the device's copy now disagrees with the
           server and the snapshot below is what settles it. */
        Store.dropOps(applied.concat(refused.map(function (r) { return r.id; })));

        if (body.snapshot) Store.hydrate(body.snapshot);
        cfg.lastSync = Date.now();
        cfg.lastError = refused.length ? refused[0].message : null;
        persist();
        return { ok: refused.length === 0, applied: applied.length, refused: refused };
      }

      if (body.snapshot) Store.hydrate(body.snapshot);
      cfg.lastSync = Date.now();
      cfg.lastError = null;
      persist();
      return { ok: true, applied: 0, refused: [] };
    });
  }

  function stripLocal(op) {
    var copy = {};
    Object.keys(op).forEach(function (k) { if (k !== '_id' && k !== '_at') copy[k] = op[k]; });
    return copy;
  }

  /* The first sync of a device that has been running standalone: if the
     pharmacy has no stock yet, everything on this handset goes up as the
     starting point. If it already has stock, this device pulls instead —
     two histories are never interleaved. */
  function seedIfEmpty() {
    return workerCall('/v1/pull', { method: 'POST' }).then(function (body) {
      var snap = body.snapshot;
      if (snap && snap.medicines && snap.medicines.length) {
        Store.hydrate(snap);
        return { ok: true, seeded: false };
      }
      var payload = Store.seedPayload();
      return workerCall('/v1/push', {
        method: 'POST',
        body: { ops: [Object.assign({ op: 'seed' }, payload)] },
        timeout: 60000
      }).then(function (res) {
        var first = (res.results || [])[0];
        if (first && !first.ok) throw new Error(first.message);
        if (res.snapshot) Store.hydrate(res.snapshot);
        Store.clearOutbox();
        cfg.lastSync = Date.now();
        persist();
        return { ok: true, seeded: true };
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * Public
   * ------------------------------------------------------------------ */
  function sync() {
    var c = config();
    if (c.mode === OFF) return Promise.resolve({ ok: true, skipped: 'off' });
    if (syncing) return Promise.resolve({ ok: true, skipped: 'busy' });

    if (!signedIn()) return Promise.resolve({ ok: false, skipped: 'signed-out' });

    syncing = true;
    announce();

    return workerSync().then(function (result) {
      syncing = false;
      if (result && result.ok) { cfg.lastSync = Date.now(); persist(); }
      announce();
      return result;
    }, function (e) {
      syncing = false;
      cfg.lastError = e.message;
      persist();
      return { ok: false, message: e.message };
    });
  }

  /* The first sync of a device that has been running standalone: if the
     pharmacy has no stock yet, everything on this handset goes up as the
     starting point. If it already has stock, this device pulls instead —
     two histories are never interleaved. */
  function seedIfEmpty() {
    return workerCall('/v1/pull', { method: 'POST' }).then(function (body) {
      var snap = body.snapshot;
      if (snap && snap.medicines && snap.medicines.length) {
        Store.hydrate(snap);
        return { ok: true, seeded: false };
      }
      var payload = Store.seedPayload();
      return workerCall('/v1/push', {
        method: 'POST',
        body: { ops: [Object.assign({ op: 'seed' }, payload)] },
        timeout: 60000
      }).then(function (res) {
        var first = (res.results || [])[0];
        if (first && !first.ok) throw new Error(first.message);
        if (res.snapshot) Store.hydrate(res.snapshot);
        Store.clearOutbox();
        cfg.lastSync = Date.now();
        persist();
        return { ok: true, seeded: true };
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * Public
   * ------------------------------------------------------------------ */
  function sync() {
    var c = config();
    if (c.mode === OFF) return Promise.resolve({ ok: true, skipped: 'off' });
    if (syncing) return Promise.resolve({ ok: true, skipped: 'busy' });

    if (!signedIn()) return Promise.resolve({ ok: false, skipped: 'signed-out' });

    syncing = true;
    announce();

    return workerSync().then(function (result) {
      syncing = false;
      if (result && result.ok) { cfg.lastSync = Date.now(); persist(); }
      announce();
      return result;
    }, function (e) {
      syncing = false;
      cfg.lastError = e.message;
      persist();
      return { ok: false, message: e.message };
    });
  }

  /* Replaces everything on this device with the copy in Turso. Direct mode
     only — worker mode gets a fresh snapshot on every sync anyway. */
  function restore() {
    if (config().mode !== DIRECT) return Promise.reject(new Error('Restore is for direct mode'));
    return directPull().then(function (r) {
      if (r.empty) return { ok: false, message: 'There is nothing stored in that database yet' };
      cfg.lastSync = Date.now();
      persist();
      return { ok: true, message: 'Restored from Turso' };
    });
  }

  function test() {
    return health().then(function (body) {
      var missing = Object.keys(body.configured || {}).filter(function (k) {
        return k !== 'group' && !body.configured[k];
      });
      return {
        ok: missing.length === 0,
        message: missing.length
          ? 'Worker is up but missing: ' + missing.join(', ')
          : 'Worker is up and fully configured',
        configured: body.configured
      };
    });
  }

  function disconnect() {
    configure({
      mode: OFF, token: null, tokenExp: 0, accountId: null,
      lastSync: null, lastError: null
    });
    Store.setSyncEnabled(false);
  }

  global.PharmaCloud = {
    OFF: OFF, WORKER: WORKER,
    config: config, configure: configure, status: status, onChange: onChange,
    signedIn: signedIn,
    health: health, test: test, listAccounts: listAccounts,
    signIn: signIn, signOut: signOut,
    sync: sync, seedIfEmpty: seedIfEmpty, disconnect: disconnect
  };
})(typeof self !== 'undefined' ? self : this);
