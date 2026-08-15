/* =====================================================================
   PharmaCheck Admin — the client for the Worker's admin API.

   Two things are stored on this device and nothing else is: the Worker
   URL, and the session token minted when the setup key was accepted.

   The setup key itself is never written down. It is typed at sign-in,
   exchanged for a token that expires in 8 hours, and forgotten — so a
   lost handset costs one working day of access, not the key that can
   create and destroy every database in the organisation.
   ===================================================================== */
(function (global) {
  'use strict';

  var KEY = 'pharmacheck.admin.v1';
  var TIMEOUT = 25000;

  var cfg = null;

  function defaults() {
    return { workerUrl: '', token: null, tokenExp: 0, lastError: null };
  }

  function config() {
    if (cfg) return cfg;
    try {
      var raw = global.localStorage && global.localStorage.getItem(KEY);
      cfg = raw ? Object.assign(defaults(), JSON.parse(raw)) : defaults();
    } catch (e) {
      cfg = defaults();
    }
    return cfg;
  }

  function persist() {
    try {
      if (global.localStorage) global.localStorage.setItem(KEY, JSON.stringify(cfg));
    } catch (e) { /* private mode — settings just will not survive a restart */ }
  }

  function configure(patch) {
    config();
    Object.keys(patch || {}).forEach(function (k) { cfg[k] = patch[k]; });
    if (cfg.workerUrl) cfg.workerUrl = String(cfg.workerUrl).trim().replace(/\/+$/, '');
    persist();
    return cfg;
  }

  function signedIn() {
    var c = config();
    return Boolean(c.token && c.tokenExp > Date.now());
  }

  /* ------------------------------------------------------------------ *
   * HTTP
   * ------------------------------------------------------------------ */
  function request(url, opts) {
    var o = opts || {};
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, o.timeout || TIMEOUT);
    var done = function (v) { clearTimeout(timer); return v; };

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
      if (e.name === 'AbortError') throw new Error('The Worker did not answer in time');
      if (e instanceof TypeError) throw new Error('Could not reach the Worker — check the URL and the connection');
      throw e;
    }).catch(function (e) { done(); throw e; });
  }

  /* A 401 anywhere means the session is over, so the token is dropped at
     the point of failure rather than leaving the app to discover it screen
     by screen. */
  function call(path, opts) {
    var c = config();
    if (!c.workerUrl) return Promise.reject(new Error('Set the Worker URL in Settings first'));

    var o = opts || {};
    var headers = { 'content-type': 'application/json' };
    if (o.auth !== false && c.token) headers.authorization = 'Bearer ' + c.token;

    return request(c.workerUrl + path, {
      method: o.method || 'GET',
      headers: headers,
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
      timeout: o.timeout
    }).catch(function (e) {
      if (e.status === 401 && o.auth !== false) {
        configure({ token: null, tokenExp: 0 });
        e.signedOut = true;
      }
      throw e;
    });
  }

  /* ------------------------------------------------------------------ *
   * Session
   * ------------------------------------------------------------------ */
  function health(url) {
    var target = (url || config().workerUrl || '').trim().replace(/\/+$/, '');
    if (!target) return Promise.reject(new Error('Enter the Worker URL first'));
    return request(target + '/v1/health', { timeout: 12000 });
  }

  function signIn(workerUrl, setupKey) {
    configure({ workerUrl: workerUrl });
    return call('/v1/admin/signin', {
      method: 'POST', auth: false, body: { setupKey: setupKey }
    }).then(function (body) {
      configure({ token: body.token, tokenExp: body.expiresAt, lastError: null });
      return { ok: true, expiresAt: body.expiresAt };
    });
  }

  function signOut() { configure({ token: null, tokenExp: 0 }); }

  /* ------------------------------------------------------------------ *
   * Turso configuration
   * ------------------------------------------------------------------ */
  function getConfig() {
    return call('/v1/admin/config').then(function (b) { return b.config; });
  }

  function putConfig(fields) {
    return call('/v1/admin/config', { method: 'PUT', body: fields })
      .then(function (b) { return b.config; });
  }

  // Creating a database can take a while, so does confirming we could.
  function testTurso() {
    return call('/v1/admin/config/test', { timeout: 40000 });
  }

  /* ------------------------------------------------------------------ *
   * Pharmacies and accounts
   * ------------------------------------------------------------------ */
  function overview() { return call('/v1/admin/overview', { timeout: 45000 }); }

  function pharmacies() {
    return call('/v1/admin/pharmacies').then(function (b) { return b.pharmacies || []; });
  }

  function pharmacy(code) {
    return call('/v1/admin/pharmacies/' + encodeURIComponent(code));
  }

  function createPharmacy(fields) {
    return call('/v1/admin/pharmacies', { method: 'POST', body: fields, timeout: 60000 });
  }

  function archivePharmacy(code, dropDatabase) {
    return call('/v1/admin/pharmacies/' + encodeURIComponent(code), {
      method: 'DELETE', body: { dropDatabase: Boolean(dropDatabase) }, timeout: 45000
    });
  }

  function createAccount(code, fields) {
    return call('/v1/admin/pharmacies/' + encodeURIComponent(code) + '/accounts', {
      method: 'POST', body: fields
    });
  }

  function updateAccount(code, id, fields) {
    return call('/v1/admin/pharmacies/' + encodeURIComponent(code) + '/accounts/' + encodeURIComponent(id), {
      method: 'PATCH', body: fields
    });
  }

  function removeAccount(code, id) {
    return call('/v1/admin/pharmacies/' + encodeURIComponent(code) + '/accounts/' + encodeURIComponent(id), {
      method: 'DELETE', body: {}
    });
  }

  global.AdminApi = {
    config: config, configure: configure, signedIn: signedIn,
    health: health, signIn: signIn, signOut: signOut,
    getConfig: getConfig, putConfig: putConfig, testTurso: testTurso,
    overview: overview, pharmacies: pharmacies, pharmacy: pharmacy,
    createPharmacy: createPharmacy, archivePharmacy: archivePharmacy,
    createAccount: createAccount, updateAccount: updateAccount, removeAccount: removeAccount
  };
})(typeof self !== 'undefined' ? self : this);
