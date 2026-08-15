/* =====================================================================
   PharmaCheck Admin — application logic

   Four screens above any single pharmacy: an overview of the estate, the
   list of pharmacies, one pharmacy's accounts, and the settings that say
   what this app is connected to.

   Everything here goes through AdminApi, which holds a session minted
   from the setup key. Nothing is cached across sign-ins — each screen
   asks the Worker, because the Worker is the only thing that knows.
   ===================================================================== */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

  var Api = window.AdminApi;
  var isNative = Boolean(window.__PHARMACHECK_NATIVE__ || window.ReactNativeWebView);
  if (isNative) document.documentElement.classList.add('is-native');

  function postToNative(message) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(message));
    }
  }

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function money(value) {
    var n = Number(value) || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M DA';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k DA';
    return Math.round(n) + ' DA';
  }

  function plural(n, one, many) {
    return n + ' ' + (Number(n) === 1 ? one : (many || one + 's'));
  }

  function ago(ts) {
    if (!ts) return 'never';
    var secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (secs < 60) return 'just now';
    if (secs < 5400) return Math.round(secs / 60) + ' min ago';
    if (secs < 172800) return Math.round(secs / 3600) + ' h ago';
    return new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function initials(name) {
    return String(name || '?').split(/\s+/).map(function (w) { return w[0]; })
      .join('').slice(0, 2).toUpperCase();
  }

  var toastTimer = null;
  function toast(message) {
    var el = $('#toast');
    el.textContent = message;
    el.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('is-on'); }, 3200);
  }

  function result(sel, text, kind) {
    var node = $(sel);
    if (!text) { node.hidden = true; return; }
    node.hidden = false;
    node.textContent = text;
    node.className = 'setresult setresult--' + (kind || 'ok');
  }

  function tickClock() {
    var now = new Date();
    $('#sb-time').textContent = now.getHours() + ':' + String(now.getMinutes()).padStart(2, '0');
  }
  tickClock();
  setInterval(tickClock, 20000);

  /* A signed-out session is not an error to report on five screens — it
     is a single trip back to sign-in. */
  function handle(e) {
    if (e && e.signedOut) {
      go('signin');
      toast('That session expired — sign in again');
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ *
   * Routing
   * ------------------------------------------------------------------ */
  var SCREENS = ['signin', 'dashboard', 'pharmacies', 'detail', 'settings'];
  var TAB_FOR_SCREEN = { dashboard: 'dashboard', pharmacies: 'pharmacies', detail: 'pharmacies', settings: 'settings' };

  var current = 'signin';
  var currentPharmacy = null;

  function go(name) {
    if (SCREENS.indexOf(name) === -1 || !$('#screen-' + name)) return;

    // Everything but sign-in needs a session.
    if (name !== 'signin' && !Api.signedIn()) name = 'signin';

    $$('.screen').forEach(function (s) { s.classList.remove('is-active'); });
    $('#screen-' + name).classList.add('is-active');

    $('#tabs').hidden = name === 'signin';
    var owner = TAB_FOR_SCREEN[name];
    $$('.tab').forEach(function (t) {
      var on = t.dataset.go === owner;
      t.classList.toggle('is-on', on);
      if (on) t.setAttribute('aria-current', 'page');
      else t.removeAttribute('aria-current');
    });

    if (name === 'signin') renderSignIn();
    if (name === 'dashboard') renderDashboard();
    if (name === 'pharmacies') renderPharmacies();
    if (name === 'detail') renderDetail();
    if (name === 'settings') renderSettings();

    var screen = $('#screen-' + name);
    if (screen.classList.contains('screen--scroll')) screen.scrollTop = 0;

    current = name;
    postToNative({ type: 'screen', name: name });
  }

  window.__pharmaadminBack = function () {
    if (anySheetOpen()) { closeSheets(); return; }
    if (current === 'detail') { go('pharmacies'); return; }
    if (current !== 'dashboard' && current !== 'signin') { go('dashboard'); return; }
  };

  document.addEventListener('click', function (event) {
    var trigger = event.target.closest('[data-go]');
    if (trigger) go(trigger.dataset.go);
  });

  /* ------------------------------------------------------------------ *
   * Sheets
   * ------------------------------------------------------------------ */
  var scrim = $('#scrim');
  var sheets = { newPharmacy: $('#new-sheet'), account: $('#acct-sheet'), confirm: $('#confirm-sheet') };

  function anySheetOpen() {
    return Object.keys(sheets).some(function (k) { return sheets[k].classList.contains('is-open'); });
  }

  function openSheet(sheet) {
    scrim.hidden = false;
    requestAnimationFrame(function () { scrim.classList.add('is-on'); });
    sheet.classList.add('is-open');
    sheet.setAttribute('aria-hidden', 'false');
  }

  function closeSheets() {
    scrim.classList.remove('is-on');
    Object.keys(sheets).forEach(function (k) {
      sheets[k].classList.remove('is-open');
      sheets[k].setAttribute('aria-hidden', 'true');
    });
    setTimeout(function () { if (!anySheetOpen()) scrim.hidden = true; }, 320);
  }

  scrim.addEventListener('click', closeSheets);

  function markBad(input, message) {
    var field = input.closest('.field');
    if (field) {
      field.classList.add('is-bad');
      var err = field.querySelector('.field__error');
      if (err) err.textContent = message;
    }
    input.focus({ preventScroll: true });
  }

  function clearBad(form) {
    $$('.field', form).forEach(function (f) {
      f.classList.remove('is-bad');
      var err = f.querySelector('.field__error');
      if (err) err.textContent = '';
    });
  }

  /* ------------------------------------------------------------------ *
   * 0. Sign in
   * ------------------------------------------------------------------ */
  function renderSignIn() {
    var c = Api.config();
    $('#si-url').value = c.workerUrl || '';
    result('#si-result', '');
  }

  $('#si-go').addEventListener('click', function () {
    var url = $('#si-url').value.trim();
    var key = $('#si-key').value;

    if (!url) { result('#si-result', 'Enter the Worker URL', 'bad'); return; }
    if (!key) { result('#si-result', 'Enter the setup key', 'bad'); return; }

    result('#si-result', 'Signing in…', 'busy');
    $('#si-go').disabled = true;

    Api.signIn(url, key).then(function () {
      $('#si-key').value = '';        // never kept, not even in the field
      $('#si-go').disabled = false;
      result('#si-result', '');
      go('dashboard');
    }, function (e) {
      $('#si-go').disabled = false;
      result('#si-result', e.message, 'bad');
    });
  });

  $('#si-key').addEventListener('keydown', function (event) {
    if (event.key === 'Enter') $('#si-go').click();
  });

  /* ------------------------------------------------------------------ *
   * 1. Dashboard
   * ------------------------------------------------------------------ */
  function renderDashboard() {
    $('#dash-date').textContent = new Date().toLocaleDateString([], {
      weekday: 'long', day: 'numeric', month: 'long'
    });
    $('#dash-sub').textContent = 'Loading…';
    $('#ov-list').innerHTML = '<li class="emptynote">Loading…</li>';

    Api.overview().then(function (body) {
      var t = body.totals;
      $('#ov-pharmacies').textContent = t.pharmacies;
      $('#ov-accounts').textContent = t.accounts;
      $('#ov-vendors').textContent = plural(t.vendors, 'vendor');
      $('#ov-medicines').textContent = t.medicines;
      $('#ov-sales').textContent = t.sales;
      $('#ov-revenue').textContent = money(t.revenue) + ' taken';
      $('#dash-sub').textContent = t.pharmacies
        ? plural(t.pharmacies, 'pharmacy', 'pharmacies') + ' · ' + plural(t.accounts, 'account')
        : 'No pharmacies yet';

      $('#ov-list').innerHTML = body.pharmacies.length
        ? body.pharmacies.map(pharmacyRow).join('')
        : '<li class="emptynote">No pharmacies yet.<br>Create the first one from the Pharmacies tab.</li>';
    }, function (e) {
      if (handle(e)) return;
      $('#dash-sub').textContent = 'Could not load';
      $('#ov-list').innerHTML = '<li class="emptynote">' + escapeHtml(e.message) + '</li>';
    });
  }

  function pharmacyRow(p) {
    var meta = p.reachable === false
      ? 'Database unreachable'
      : plural(p.managers || 0, 'manager') + ' · ' + plural(p.vendors || 0, 'vendor') +
        (p.sales ? ' · ' + plural(p.sales, 'sale') : '');

    return '' +
      '<li><button class="rowcard" type="button" data-pharmacy="' + escapeHtml(p.code) + '">' +
        '<span class="rowcard__badge' + (p.reachable === false ? ' rowcard__badge--off' : '') + '">' +
          escapeHtml(p.code.slice(0, 2).toUpperCase()) + '</span>' +
        '<span class="rowcard__body">' +
          '<span class="rowcard__name">' + escapeHtml(p.code) +
            (p.reachable === false ? ' <span class="pill pill--off">error</span>' : '') + '</span>' +
          '<span class="rowcard__meta">' + escapeHtml(meta) + '</span>' +
        '</span>' +
        '<svg class="icon icon--xs rowcard__go"><use href="#i-chevron"/></svg>' +
      '</button></li>';
  }

  $('#dash-refresh').addEventListener('click', function () {
    renderDashboard();
    toast('Refreshing…');
  });

  /* ------------------------------------------------------------------ *
   * 2. Pharmacies
   * ------------------------------------------------------------------ */
  var pharmacyCache = [];

  function renderPharmacies() {
    $('#ph-sub').textContent = 'Loading…';
    $('#ph-list').innerHTML = '<li class="emptynote">Loading…</li>';

    Api.pharmacies().then(function (list) {
      pharmacyCache = list;
      $('#ph-sub').textContent = list.length
        ? plural(list.length, 'pharmacy', 'pharmacies')
        : 'None yet';
      paintPharmacyList();
    }, function (e) {
      if (handle(e)) return;
      $('#ph-sub').textContent = 'Could not load';
      $('#ph-list').innerHTML = '<li class="emptynote">' + escapeHtml(e.message) + '</li>';
    });
  }

  function paintPharmacyList() {
    var q = $('#ph-search').value.trim().toLowerCase();
    var list = q
      ? pharmacyCache.filter(function (p) { return p.code.indexOf(q) !== -1; })
      : pharmacyCache;

    $('#ph-list').innerHTML = list.length
      ? list.map(function (p) {
          return '' +
            '<li><button class="rowcard" type="button" data-pharmacy="' + escapeHtml(p.code) + '">' +
              '<span class="rowcard__badge">' + escapeHtml(p.code.slice(0, 2).toUpperCase()) + '</span>' +
              '<span class="rowcard__body">' +
                '<span class="rowcard__name">' + escapeHtml(p.code) + '</span>' +
                '<span class="rowcard__meta">' + escapeHtml(p.database) +
                  (p.createdAt ? ' · added ' + ago(p.createdAt) : '') + '</span>' +
              '</span>' +
              '<svg class="icon icon--xs rowcard__go"><use href="#i-chevron"/></svg>' +
            '</button></li>';
        }).join('')
      : '<li class="emptynote">' + (q ? 'Nothing matches “' + escapeHtml(q) + '”'
                                      : 'No pharmacies yet.<br>Create one with the button below.') + '</li>';
  }

  $('#ph-search').addEventListener('input', paintPharmacyList);

  document.addEventListener('click', function (event) {
    var btn = event.target.closest('[data-pharmacy]');
    if (!btn) return;
    currentPharmacy = btn.dataset.pharmacy;
    go('detail');
  });

  /* --------------------------- new pharmacy --------------------------- */
  $('#ph-add').addEventListener('click', function () {
    var form = $('#new-form');
    form.reset();
    clearBad(form);
    result('#np-result', '');
    openSheet(sheets.newPharmacy);
    $('#np-code').focus({ preventScroll: true });
  });

  $('#np-cancel').addEventListener('click', closeSheets);

  /* The code is a database name, so it is normalised as it is typed
     rather than rejected afterwards. */
  $('#np-code').addEventListener('input', function () {
    var clean = this.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    if (clean !== this.value) this.value = clean;
  });

  $('#new-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var form = event.target;
    clearBad(form);

    var fields = {
      code: $('#np-code').value.trim(),
      label: $('#np-label').value.trim(),
      managerName: $('#np-manager').value.trim(),
      managerPin: $('#np-pin').value.trim()
    };

    if (fields.code.replace(/-/g, '').length < 3) {
      markBad($('#np-code'), 'At least 3 letters or digits'); return;
    }
    if (!fields.managerName) { markBad($('#np-manager'), 'The manager needs a name'); return; }
    if (!/^\d{4}$/.test(fields.managerPin)) { markBad($('#np-pin'), 'Exactly 4 digits'); return; }

    result('#np-result', 'Creating the database — this takes a few seconds…', 'busy');
    $('#np-save').disabled = true;

    Api.createPharmacy(fields).then(function (body) {
      $('#np-save').disabled = false;
      closeSheets();
      toast('Created “' + body.pharmacy.code + '”');
      currentPharmacy = body.pharmacy.code;
      go('detail');
    }, function (e) {
      $('#np-save').disabled = false;
      if (handle(e)) return;
      result('#np-result', e.message, 'bad');
    });
  });

  /* ------------------------------------------------------------------ *
   * 3. Pharmacy detail
   * ------------------------------------------------------------------ */
  var detailCache = null;

  function renderDetail() {
    if (!currentPharmacy) { go('pharmacies'); return; }

    $('#dt-code').textContent = currentPharmacy;
    $('#dt-sub').textContent = 'Loading…';
    $('#dt-managers').innerHTML = '<li class="emptynote">Loading…</li>';
    $('#dt-vendors').innerHTML = '';

    Api.pharmacy(currentPharmacy).then(function (body) {
      detailCache = body;

      $('#dt-sub').textContent = plural(body.accounts.length, 'account') +
        (body.lastSaleAt ? ' · last sale ' + ago(body.lastSaleAt) : ' · no sales yet');
      $('#dt-db').textContent = body.database;
      $('#dt-created').textContent = body.createdAt ? 'Created ' + ago(body.createdAt) : 'Turso database';

      $('#dt-medicines').textContent = body.medicines;
      $('#dt-units').textContent = plural(body.units || 0, 'unit') + ' on the shelf';
      $('#dt-sales').textContent = body.sales;
      $('#dt-revenue').textContent = money(body.revenue) + ' taken';

      var managers = body.accounts.filter(function (a) { return a.role === 'manager'; });
      var vendors = body.accounts.filter(function (a) { return a.role === 'vendor'; });

      $('#dt-managers').innerHTML = managers.length
        ? managers.map(accountRow).join('')
        : '<li class="emptynote">No manager — add one, or nobody can run this pharmacy.</li>';
      $('#dt-vendors').innerHTML = vendors.length
        ? vendors.map(accountRow).join('')
        : '<li class="emptynote">No vendors yet.</li>';

      $('#dt-url').textContent = Api.config().workerUrl || '—';
      $('#dt-copycode').textContent = body.code;
    }, function (e) {
      if (handle(e)) return;
      $('#dt-sub').textContent = 'Could not load';
      $('#dt-managers').innerHTML = '<li class="emptynote">' + escapeHtml(e.message) + '</li>';
    });
  }

  function accountRow(a) {
    var badge = a.role === 'manager' ? ' rowcard__badge--mgr' : ' rowcard__badge--vendor';
    return '' +
      '<li><button class="rowcard" type="button" data-account="' + escapeHtml(a.id) + '">' +
        '<span class="rowcard__badge' + (a.active ? badge : ' rowcard__badge--off') + '">' +
          escapeHtml(initials(a.name)) + '</span>' +
        '<span class="rowcard__body">' +
          '<span class="rowcard__name">' + escapeHtml(a.name) +
            (a.active ? '' : ' <span class="pill pill--off">off</span>') + '</span>' +
          '<span class="rowcard__meta">' + (a.role === 'manager' ? 'Manager' : 'Vendor') +
            ' · added ' + ago(a.createdAt) + '</span>' +
        '</span>' +
        '<svg class="icon icon--xs rowcard__go"><use href="#i-pen"/></svg>' +
      '</button></li>';
  }

  /* --------------------------- account sheet -------------------------- */
  var editingAccount = null;
  var editingRole = 'vendor';

  $$('[data-add-role]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      editingAccount = null;
      editingRole = btn.dataset.addRole;
      openAccountSheet();
    });
  });

  document.addEventListener('click', function (event) {
    var btn = event.target.closest('[data-account]');
    if (!btn || !detailCache) return;
    editingAccount = detailCache.accounts.filter(function (a) { return a.id === btn.dataset.account; })[0] || null;
    if (!editingAccount) return;
    editingRole = editingAccount.role;
    openAccountSheet();
  });

  function openAccountSheet() {
    var form = $('#acct-form');
    form.reset();
    clearBad(form);
    result('#ac-result', '');

    var isEdit = Boolean(editingAccount);
    $('#ac-title').textContent = isEdit
      ? editingAccount.name
      : (editingRole === 'manager' ? 'Add manager' : 'Add vendor');
    $('#ac-name').value = isEdit ? editingAccount.name : '';
    $('#ac-active').checked = isEdit ? editingAccount.active : true;
    $('#ac-active-row').hidden = !isEdit;
    $('#ac-remove').hidden = !isEdit;

    // On an existing account a blank PIN means "leave it alone", so the
    // label has to say which of the two this is.
    $('#ac-pin-label').textContent = isEdit ? 'New PIN (blank to keep the current one)' : '4-digit PIN';
    $('#ac-pin').placeholder = isEdit ? '••••' : '1234';

    openSheet(sheets.account);
    // preventScroll for the same reason the body is pinned: focusing a
    // field in a sheet that is still animating in must not scroll anything.
    if (!isEdit) $('#ac-name').focus({ preventScroll: true });
  }

  $('#ac-cancel').addEventListener('click', closeSheets);

  $('#acct-form').addEventListener('submit', function (event) {
    event.preventDefault();
    clearBad(event.target);

    var name = $('#ac-name').value.trim();
    var pin = $('#ac-pin').value.trim();
    var active = $('#ac-active').checked;

    if (!name) { markBad($('#ac-name'), 'A name is required'); return; }
    if (!editingAccount && !/^\d{4}$/.test(pin)) { markBad($('#ac-pin'), 'Exactly 4 digits'); return; }
    if (editingAccount && pin && !/^\d{4}$/.test(pin)) { markBad($('#ac-pin'), 'Exactly 4 digits, or leave blank'); return; }

    result('#ac-result', 'Saving…', 'busy');
    $('#ac-save').disabled = true;

    var done = function (message) {
      $('#ac-save').disabled = false;
      closeSheets();
      toast(message);
      renderDetail();
    };
    var failed = function (e) {
      $('#ac-save').disabled = false;
      if (handle(e)) return;
      result('#ac-result', e.message, 'bad');
    };

    if (editingAccount) {
      var patch = { name: name, active: active };
      if (pin) patch.pin = pin;
      Api.updateAccount(currentPharmacy, editingAccount.id, patch)
        .then(function () { done(name + ' updated'); }, failed);
    } else {
      Api.createAccount(currentPharmacy, { name: name, pin: pin, role: editingRole })
        .then(function () { done(name + ' added'); }, failed);
    }
  });

  $('#ac-remove').addEventListener('click', function () {
    if (!editingAccount) return;
    result('#ac-result', 'Removing…', 'busy');
    Api.removeAccount(currentPharmacy, editingAccount.id).then(function (body) {
      closeSheets();
      toast(body.message || 'Removed');
      renderDetail();
    }, function (e) {
      if (handle(e)) return;
      result('#ac-result', e.message, 'bad');
    });
  });

  /* --------------------------- archiving ------------------------------ *
   * Two guards, because one of these two outcomes destroys records that
   * cannot be got back: the code has to be typed out, and deleting the
   * database is a separate switch that is off by default.
   * ------------------------------------------------------------------ */
  $('#dt-archive').addEventListener('click', function () {
    if (!currentPharmacy) return;
    $('#cf-title').textContent = 'Archive “' + currentPharmacy + '”?';
    $('#cf-body').textContent =
      'Phones will stop being able to reach this pharmacy. By default its database is kept, ' +
      'so the records survive and it can be restored by creating it again with the same code.';
    $('#cf-drop').checked = false;
    $('#cf-type').value = '';
    $('#cf-type').placeholder = currentPharmacy;
    result('#cf-result', '');
    $('#cf-go').textContent = 'Archive';
    openSheet(sheets.confirm);
  });

  $('#cf-drop').addEventListener('change', function () {
    $('#cf-go').textContent = this.checked ? 'Delete everything' : 'Archive';
    $('#cf-body').textContent = this.checked
      ? 'This deletes the Turso database and every record in it — stock, sales and prescriptions. ' +
        'There is no undo and no backup.'
      : 'Phones will stop being able to reach this pharmacy. By default its database is kept, ' +
        'so the records survive and it can be restored by creating it again with the same code.';
    $('#cf-body').className = 'sheet__note ' + (this.checked ? 'sheet__note--warn' : 'sheet__note--info');
  });

  $('#cf-cancel').addEventListener('click', closeSheets);

  $('#cf-go').addEventListener('click', function () {
    if ($('#cf-type').value.trim() !== currentPharmacy) {
      result('#cf-result', 'Type “' + currentPharmacy + '” exactly to confirm', 'bad');
      return;
    }

    var drop = $('#cf-drop').checked;
    result('#cf-result', drop ? 'Deleting…' : 'Archiving…', 'busy');
    $('#cf-go').disabled = true;

    Api.archivePharmacy(currentPharmacy, drop).then(function (body) {
      $('#cf-go').disabled = false;
      closeSheets();
      toast(body.message || 'Done');
      currentPharmacy = null;
      go('pharmacies');
    }, function (e) {
      $('#cf-go').disabled = false;
      if (handle(e)) return;
      result('#cf-result', e.message, 'bad');
    });
  });

  /* ------------------------------------------------------------------ *
   * 4. Settings
   * ------------------------------------------------------------------ */
  function renderSettings() {
    $('#st-url').value = Api.config().workerUrl || '';
    result('#st-url-result', '');
    result('#st-turso-result', '');
    loadConfig();
  }

  function loadConfig() {
    $('#st-source').textContent = 'Loading…';
    $('#st-checklist').innerHTML = '<li class="emptynote">Loading…</li>';

    Api.getConfig().then(function (c) {
      $('#st-org').value = c.org.value || '';
      $('#st-group').value = c.group.value || 'default';
      $('#st-token').value = '';

      // Where a value came from decides whether editing it here does
      // anything at all, so it is stated rather than implied.
      $('#st-source').textContent = c.platformToken.source === 'worker-secret'
        ? 'These come from Worker secrets set with wrangler. Editing them here has no effect until those are removed.'
        : c.platformToken.set
          ? 'These were set from this app and are stored by the Worker.'
          : 'Not configured yet. Fill these in to create pharmacies.';
      $('#st-source').className = 'sheet__note ' +
        (c.platformToken.source === 'worker-secret' ? 'sheet__note--info'
          : c.platformToken.set ? 'sheet__note--info' : 'sheet__note--warn');

      $('#st-checklist').innerHTML = [
        check('Turso organisation', c.org.set !== false && c.org.value, c.org.value
          ? 'Set to “' + c.org.value + '”' + sourceNote(c.org.source)
          : 'Needed before a pharmacy can be created.'),
        check('Turso group', Boolean(c.group.value), 'Databases are created in “' + (c.group.value || 'default') + '”.'),
        check('Platform token', c.platformToken.set,
          c.platformToken.set ? 'Set' + sourceNote(c.platformToken.source)
            : 'Needed before a pharmacy can be created.'),
        check('Session secret', c.sessionSecret.set,
          c.sessionSecret.set ? 'Signs sign-in tokens.'
            : 'Nobody can sign in until this is set: <code>wrangler secret put SESSION_SECRET</code>'),
        check('Setup key', c.setupKey.set,
          c.setupKey.set ? 'What you signed in with.' : '<code>wrangler secret put SETUP_KEY</code>'),
        check('KV namespace', c.kv.set,
          c.kv.set ? 'Where the pharmacy index lives.' : 'Bind PHARMACIES in wrangler.toml.')
      ].join('');
    }, function (e) {
      if (handle(e)) return;
      $('#st-source').textContent = e.message;
      $('#st-checklist').innerHTML = '<li class="emptynote">' + escapeHtml(e.message) + '</li>';
    });
  }

  function sourceNote(source) {
    if (source === 'worker-secret') return ' · from a Worker secret';
    if (source === 'admin-app') return ' · set from this app';
    return '';
  }

  function check(name, ok, why) {
    return '' +
      '<li class="chk">' +
        '<span class="chk__dot chk__dot--' + (ok ? 'ok' : 'no') + '">' +
          '<svg class="icon icon--xs"><use href="#i-' + (ok ? 'check' : 'alert') + '"/></svg></span>' +
        '<span class="chk__name">' + escapeHtml(name) + '</span>' +
        '<span class="pill pill--' + (ok ? 'ok' : 'off') + '">' + (ok ? 'set' : 'missing') + '</span>' +
        '<span class="chk__why">' + why + '</span>' +
      '</li>';
  }

  $('#st-check').addEventListener('click', function () {
    var url = $('#st-url').value.trim();
    if (!url) { result('#st-url-result', 'Enter the Worker URL first', 'bad'); return; }
    result('#st-url-result', 'Checking…', 'busy');
    Api.health(url).then(function (body) {
      result('#st-url-result', 'Worker is up (v' + body.version + ')', 'ok');
    }, function (e) {
      result('#st-url-result', e.message, 'bad');
    });
  });

  $('#st-save-url').addEventListener('click', function () {
    var url = $('#st-url').value.trim();
    if (!url) { result('#st-url-result', 'Enter the Worker URL first', 'bad'); return; }
    Api.configure({ workerUrl: url });
    result('#st-url-result', 'Saved', 'ok');
    toast('Worker URL saved');
  });

  $('#st-save-turso').addEventListener('click', function () {
    var fields = { org: $('#st-org').value.trim(), group: $('#st-group').value.trim() || 'default' };
    // A blank token means "keep the current one", so it is only sent when
    // something was actually typed.
    var token = $('#st-token').value.trim();
    if (token) fields.token = token;

    if (!fields.org) { result('#st-turso-result', 'Enter the Turso organisation', 'bad'); return; }

    result('#st-turso-result', 'Saving…', 'busy');
    Api.putConfig(fields).then(function () {
      $('#st-token').value = '';
      result('#st-turso-result', 'Saved. Press Test to confirm Turso accepts it.', 'ok');
      loadConfig();
    }, function (e) {
      if (handle(e)) return;
      result('#st-turso-result', e.message, 'bad');
    });
  });

  $('#st-test').addEventListener('click', function () {
    result('#st-turso-result', 'Asking Turso…', 'busy');
    Api.testTurso().then(function (body) {
      result('#st-turso-result', body.message, body.ok ? 'ok' : 'bad');
    }, function (e) {
      if (handle(e)) return;
      result('#st-turso-result', e.message, 'bad');
    });
  });

  $('#st-signout').addEventListener('click', function () {
    Api.signOut();
    go('signin');
    toast('Signed out');
  });

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */
  go(Api.signedIn() ? 'dashboard' : 'signin');
})();
