/* =====================================================================
   PharmaCheck — application logic

   Screen routing, live QR scanning, prescription codes, inventory and
   reporting. Every figure shown comes from PharmaStore; the scanner decodes
   real camera frames. Nothing here is a placeholder.
   ===================================================================== */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

  var phone = $('.phone');
  var Store = window.PharmaStore;

  /* ------------------------------------------------------------------ *
   * Native shell bridge (no-ops in a plain browser)
   * ------------------------------------------------------------------ */
  var isNative = Boolean(window.__PHARMACHECK_NATIVE__ || window.ReactNativeWebView);
  if (isNative) document.documentElement.classList.add('is-native');

  function postToNative(message) {
    if (!window.ReactNativeWebView) return;
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify(message));
    } catch (e) { /* bridge unavailable */ }
  }

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function money(value, decimals) {
    var d = decimals === undefined ? 2 : decimals;
    return '$' + Number(value).toLocaleString('en-US', {
      minimumFractionDigits: d, maximumFractionDigits: d
    });
  }

  function units(n) { return n + (Number(n) === 1 ? ' unit' : ' units'); }

  function ago(timestamp) {
    if (!timestamp) return '';
    var mins = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    var hours = Math.round(mins / 60);
    if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
    var days = Math.round(hours / 24);
    return days + (days === 1 ? ' day ago' : ' days ago');
  }

  var toastEl = $('#toast');
  var toastTimer;
  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 3000);
  }
  function hideToast() {
    clearTimeout(toastTimer);
    toastEl.classList.remove('is-on');
  }

  /* ------------------------------------------------------------------ *
   * Status bar clock
   * ------------------------------------------------------------------ */
  function tickClock() {
    $('#clock').textContent = new Date().toLocaleTimeString([], {
      hour: 'numeric', minute: '2-digit'
    }).replace(/\s?[AP]M/i, '');
  }
  tickClock();
  setInterval(tickClock, 20000);

  $('#today-label').textContent = new Date().toLocaleDateString([], {
    weekday: 'long', day: 'numeric', month: 'long'
  });

  /* ------------------------------------------------------------------ *
   * Routing
   * ------------------------------------------------------------------ */
  var TAB_FOR_SCREEN = {
    dashboard: 'dashboard', scanner: 'scanner', manual: 'scanner',
    inventory: 'inventory', reports: 'reports'
  };

  var current = 'dashboard';

  function go(name) {
    if (!$('#screen-' + name)) return;

    $$('.screen').forEach(function (s) { s.classList.remove('is-active'); });
    $('#screen-' + name).classList.add('is-active');

    var owner = TAB_FOR_SCREEN[name];
    $$('.tab').forEach(function (t) {
      var on = t.dataset.go === owner;
      t.classList.toggle('is-on', on);
      if (on) t.setAttribute('aria-current', 'page');
      else t.removeAttribute('aria-current');
    });

    phone.classList.toggle('is-dark', name === 'scanner');

    if (name === 'scanner') openCamera();
    else closeCamera();

    if (name === 'dashboard') renderDashboard();
    if (name === 'inventory') renderStock();
    if (name === 'reports') {
      renderReports(activePeriod);
      requestAnimationFrame(moveSegPill);
    }

    var screen = $('#screen-' + name);
    if (screen.classList.contains('screen--scroll')) screen.scrollTop = 0;

    current = name;
    postToNative({ type: 'screen', name: name, dark: name === 'scanner' });
  }

  window.__pharmacheckBack = function () {
    if (stockSheet.classList.contains('is-open')) { closeStockSheet(); return; }
    if (scanSheet.classList.contains('is-open')) { resumeScanning(); return; }
    if (current === 'manual') { go('scanner'); return; }
    go('dashboard');
  };

  document.addEventListener('click', function (event) {
    var trigger = event.target.closest('[data-go]');
    if (trigger) { go(trigger.dataset.go); return; }
    var teller = event.target.closest('[data-toast]');
    if (teller) toast(teller.dataset.toast);
  });

  /* ================================================================== *
   * 1. Dashboard
   * ================================================================== */
  function renderDashboard() {
    var s = Store.todaySummary();

    $('#dash-filled').textContent = s.filled;
    $('#dash-filled-delta').className = 'metric__delta' +
      (s.filledDelta > 0 ? ' metric__delta--up' : s.filledDelta < 0 ? ' metric__delta--down' : '');
    $('#dash-filled-delta').innerHTML = s.filledDelta === 0
      ? 'Same as yesterday'
      : '<svg class="icon icon--xs"><use href="#i-trend"/></svg> ' +
        Math.abs(s.filledDelta) + (s.filledDelta > 0 ? ' more' : ' fewer') + ' than yesterday';

    $('#dash-low').textContent = s.lowStock;
    $('#dash-low-meta').innerHTML = s.lowStock > 0
      ? '<svg class="icon icon--xs"><use href="#i-alert"/></svg> Reorder required'
      : 'All above reorder level';

    $('#dash-awaiting').textContent = s.awaiting;
    $('#dash-awaiting-meta').innerHTML = s.awaiting > 0
      ? '<svg class="icon icon--xs"><use href="#i-clock"/></svg> Oldest ' + ago(s.oldestAwaiting)
      : 'Nothing pending';

    $('#dash-revenue').textContent = money(s.revenue, 0);
    $('#dash-revenue-meta').textContent = s.filled + (s.filled === 1 ? ' prescription' : ' prescriptions') + ' today';

    var rows = Store.recentActivity(4);
    $('#activity-list').innerHTML = rows.length ? rows.map(function (p) {
      var filled = p.status === 'filled';
      return '' +
        '<li class="activity__row">' +
          '<span class="activity__icon"><svg class="icon"><use href="#i-pill"/></svg></span>' +
          '<span class="activity__body">' +
            '<span class="activity__name">' + escapeHtml(Store.summarise(p)) + '</span>' +
            '<span class="activity__meta">' + escapeHtml(p.patient) + ' · ' + units(Store.unitsIn(p)) + ' · ' +
              ago(p.filledAt || p.createdAt) + '</span>' +
          '</span>' +
          '<span class="badge ' + (filled ? 'badge--green' : 'badge--amber') + '">' +
            (filled ? 'Filled' : 'Pending') + '</span>' +
        '</li>';
    }).join('') : '<li class="activity__row"><span class="activity__meta">No prescriptions yet today.</span></li>';
  }

  /* The native shell calls this once expo-updates has reported in. Showing
     which bundle is live is what makes an over-the-air update observable —
     otherwise a successful update and a broken one both look like silence. */
  window.__pharmacheckBuild = function (info) {
    var line = $('#buildline');
    if (!line) return;
    if (!info) { line.textContent = ''; return; }

    var source = info.embedded ? 'shipped with the app' : 'over-the-air';
    var id = info.updateId ? String(info.updateId).slice(0, 8) : 'embedded';
    line.innerHTML =
      'PharmaCheck <b>' + escapeHtml(info.version || '1.0.0') + '</b>' +
      (info.channel ? ' · ' + escapeHtml(info.channel) : '') +
      '<br>bundle <b>' + escapeHtml(id) + '</b> · ' + source;
  };

  $('#bell').addEventListener('click', function () {
    var s = Store.todaySummary();
    toast(s.lowStock + ' medicines below reorder level · ' +
          s.awaiting + ' awaiting verification');
  });

  /* ================================================================== *
   * 2. Scanner — live camera decoding
   * ================================================================== */
  var camera = $('.camera');
  var video = $('#camera-feed');
  var scanSheet = $('#scan-sheet');
  var stream = null;
  var facing = 'environment';
  var flashOn = false;
  var scanner = new window.PharmaScanner.Scanner(video);
  var pending = null;        // the decoded payload awaiting a decision
  var barcodeIntent = null;  // 'sheet' | 'draft' when manual entry asked for a scan

  function setCamState(visible, opts) {
    var box = $('#cam-state');
    box.hidden = !visible;
    if (!visible) return;
    $('#cam-state-title').textContent = opts.title;
    $('#cam-state-body').textContent = opts.body;
    $('#cam-state-icon').innerHTML = '<use href="' + (opts.icon || '#ln-scan') + '"/>';
    $('#cam-state-actions').hidden = !opts.actions;
  }

  function openCamera() {
    if (stream) { resumeScanning(); return; }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCamState(true, {
        title: 'Camera not available',
        body: 'This browser does not expose a camera. Prescriptions can still be entered by hand.',
        icon: '#i-alert', actions: true
      });
      return;
    }

    setCamState(true, { title: 'Starting camera…', body: 'Allow camera access to scan prescription codes.' });

    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    }).then(function (media) {
      stream = media;
      video.srcObject = media;
      return video.play().catch(function () { /* autoplay policies */ });
    }).then(function () {
      camera.classList.add('is-live');
      setCamState(false);
      return scanner.negotiateFormats().then(function () {
        $('#camera-source').textContent = scanner.canReadBarcodes()
          ? 'QR + barcode' : 'QR only · jsQR';
        startScanning();
      });
    }).catch(function (err) {
      camera.classList.remove('is-live');
      var denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      var missing = err && (err.name === 'NotFoundError' || err.name === 'OverconstrainedError');
      setCamState(true, {
        title: denied ? 'Camera permission denied' : missing ? 'No camera found' : 'Camera unavailable',
        body: denied
          ? 'Enable camera access for PharmaCheck in your device settings, then try again.'
          : missing
            ? 'No camera is attached to this device.'
            : (err && err.message) || 'The camera could not be started.',
        icon: '#i-alert', actions: true
      });
    });
  }

  function closeCamera() {
    scanner.stop();
    if (!stream) return;
    stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
    video.srcObject = null;
    camera.classList.remove('is-live');
    setFlash(false);
  }

  function startScanning() {
    if (scanner.engine() === 'none') {
      setCamState(true, {
        title: 'QR decoding unsupported',
        body: 'This browser cannot decode QR codes. Use manual entry instead.',
        icon: '#i-alert', actions: true
      });
      return;
    }
    $('#camera-hint').textContent = barcodeIntent
      ? 'Align the medicine barcode within the frame'
      : scanner.canReadBarcodes()
        ? 'Align a prescription QR or medicine barcode'
        : 'Align QR Code within the frame';
    scanner.start(onDecoded, function (err) {
      toast(err.message || 'Scanning error');
    });
  }

  function resumeScanning() {
    scanSheet.classList.remove('is-open');
    scanSheet.setAttribute('aria-hidden', 'true');
    camera.classList.remove('is-locked');
    pending = null;
    $('#camera-hint').textContent = scanner.canReadBarcodes()
      ? 'Align a prescription QR or medicine barcode'
      : 'Align QR Code within the frame';
    if (stream) scanner.start(onDecoded, function () {});
  }

  $('#cam-retry').addEventListener('click', function () {
    closeCamera();
    openCamera();
  });

  /* A code came off the camera. Work out what it is and show the result. */
  function onDecoded(hit) {
    scanner.stop();
    if (navigator.vibrate) navigator.vibrate(18);
    hideToast();

    var parsed = window.PharmaScanner.parse(hit);

    /* Manual entry asked for a medicine barcode: resolve it and go straight
       back to the line editor rather than opening the dispensing sheet. */
    if (barcodeIntent && parsed.kind === 'barcode') {
      var med = Store.findByBarcode(parsed.barcode);
      var intent = barcodeIntent;
      barcodeIntent = null;
      go('manual');
      if (!med) {
        toast('Barcode ' + parsed.barcode + ' is not in the catalogue');
        openItemSheet(undefined, { medication: '' });
        return;
      }
      openItemSheet(undefined, {
        medication: med.name, strength: med.strength, form: med.form,
        packaging: med.packaging, route: Store.defaultRoute(med.form)
      });
      toast(med.name + ' — ' + med.qty + ' in stock');
      void intent;
      return;
    }

    camera.classList.add('is-locked');
    $('#camera-hint').textContent = 'Code detected';

    pending = resolvePayload(parsed);
    renderScanSheet(pending);
    setTimeout(function () {
      scanSheet.classList.add('is-open');
      scanSheet.setAttribute('aria-hidden', 'false');
    }, 420);
  }

  /* Map a decoded payload onto a prescription this pharmacy can act on. */
  function resolvePayload(parsed) {
    if (parsed.kind === 'prescription') {
      var known = Store.findByCode(parsed.code);
      if (known) {
        return {
          state: known.status === 'filled' ? 'already-filled' : 'ready',
          record: known, parsed: parsed
        };
      }
      return { state: 'new', parsed: parsed };
    }

    if (parsed.kind === 'barcode') {
      var med = Store.findByBarcode(parsed.barcode);
      return med ? { state: 'medicine', medicine: med, parsed: parsed }
                 : { state: 'unknown-barcode', parsed: parsed };
    }

    if (parsed.kind === 'code') {
      var found = Store.findByCode(parsed.code);
      if (!found) return { state: 'unknown-code', parsed: parsed };
      return {
        state: found.status === 'filled' ? 'already-filled' : 'ready',
        record: found, parsed: parsed
      };
    }

    return { state: 'unrecognised', parsed: parsed };
  }

  function renderScanSheet(result) {
    var p = result.parsed;
    var rows = [];
    var badge = 'Code verified';
    var note = '';
    var canFill = false;
    var lines = '';

    if (result.state === 'medicine') {
      var m = result.medicine;
      badge = 'Medicine identified';
      $('#scan-code').textContent = p.format.toUpperCase().replace('_', '-');
      rows.push(['Medicine', m.name]);
      if (m.strength) rows.push(['Strength', m.strength]);
      rows.push(['Form', V.formLabel(m.form)]);
      rows.push(['Packaging', V.packagingLabel(m.packaging)]);
      rows.push(['In stock', units(m.qty)]);
      rows.push(['Barcode', m.barcode]);
      note = Store.isLow(m)
        ? 'Below the reorder level of ' + m.reorder + '.'
        : 'Stock is healthy.';
    } else if (result.state === 'unknown-barcode') {
      badge = 'Barcode not recognised';
      $('#scan-code').textContent = p.barcode;
      rows.push(['Barcode', p.barcode]);
      rows.push(['Format', p.format]);
      note = 'No medicine in the catalogue carries this barcode.';
    } else if (result.state === 'unrecognised' || result.state === 'unknown-code') {
      badge = 'Not a PharmaCheck code';
      $('#scan-code').textContent = '—';
      rows.push(['Contents', p.raw.length > 90 ? p.raw.slice(0, 90) + '…' : p.raw]);
      note = result.state === 'unknown-code'
        ? 'That code is not on file at this pharmacy.'
        : 'This code does not carry a PharmaCheck prescription.';
    } else {
      var src = result.record || p;
      var items = src.items || [];
      $('#scan-code').textContent = src.code;
      rows.push(['Patient', src.patient]);
      if (src.prescriber) rows.push(['Prescriber', src.prescriber]);
      rows.push(['Medicines', items.length + (items.length === 1 ? ' line' : ' lines')]);

      lines = '<ul class="scanlines">' + items.map(function (it) {
        var med = Store.findMedicine(it.medication);
        var short = med ? med.qty + ' in stock' : 'not stocked';
        var bad = !med || med.qty < it.qty;
        var posology = [it.dose, it.frequency ? it.frequency.split(' — ')[0] : '',
                        it.duration ? it.duration.split(' — ')[0] : ''].filter(Boolean).join(' · ');
        return '<li class="scanline' + (bad ? ' scanline--bad' : '') + '">' +
          '<p class="scanline__name">' + escapeHtml(it.medication) + ' ' + escapeHtml(it.strength || '') + '</p>' +
          '<p class="scanline__meta">' + escapeHtml(V.formLabel(it.form)) + ' · ' + units(it.qty) + ' · ' +
            escapeHtml(V.routeLabel(it.route)) + ' · ' + escapeHtml(short) + '</p>' +
          (posology ? '<p class="scanline__pos">' + escapeHtml(posology) + '</p>' : '') +
          '</li>';
      }).join('') + '</ul>';

      canFill = true;
      if (result.state === 'already-filled') {
        badge = 'Already dispensed';
        note = 'Filled ' + ago(result.record.filledAt) + '. Dispensing again will draw more stock.';
      } else if (result.state === 'new') {
        badge = 'New prescription';
        note = 'Not yet on file here — filling it will record it and draw stock.';
      }

      // Every line must be available; a prescription dispenses whole or not at all.
      var probe = { items: items };
      var problems = Store.checkAvailability(probe);
      if (problems.length) {
        canFill = false;
        note = problems.length === 1
          ? problems[0].message
          : problems.length + ' lines cannot be dispensed from current stock.';
      }
    }

    $('#scan-badge-text').textContent = badge;
    $('#scan-badge').className = 'sheet__badge' + (canFill || result.state === 'medicine' ? '' : ' sheet__badge--warn');
    $('#scan-details').innerHTML = rows.map(function (r) {
      return '<div class="kv__row"><dt>' + escapeHtml(r[0]) + '</dt><dd>' + escapeHtml(r[1]) + '</dd></div>';
    }).join('') + lines;
    $('#scan-note').hidden = !note;
    $('#scan-note').textContent = note;

    var fill = $('#scan-fill');
    if (result.state === 'medicine') {
      fill.disabled = false;
      fill.textContent = 'Add to prescription';
    } else if (result.state === 'unknown-barcode' || result.state === 'unrecognised' || result.state === 'unknown-code') {
      fill.disabled = true;
      fill.textContent = 'Fill Prescription';
    } else {
      fill.disabled = !canFill;
      fill.textContent = result.state === 'already-filled' ? 'Dispense Again' : 'Fill Prescription';
    }
  }

  $('#scan-dismiss').addEventListener('click', resumeScanning);

  $('#scan-fill').addEventListener('click', function () {
    if (!pending) return;

    // A scanned medicine box feeds the manual-entry line editor.
    if (pending.state === 'medicine') {
      var m = pending.medicine;
      resumeScanning();
      go('manual');
      openItemSheet(undefined, {
        medication: m.name, strength: m.strength, form: m.form,
        packaging: m.packaging, route: Store.defaultRoute(m.form)
      });
      return;
    }

    var record = pending.record;
    if (!record) {
      var p = pending.parsed;
      record = Store.createPrescription({
        code: p.code, patient: p.patient, prescriber: p.prescriber,
        items: p.items, source: 'scan'
      });
    }

    var outcome = Store.fill(record);
    if (!outcome.ok) {
      toast(outcome.message);
      return;
    }

    resumeScanning();
    toast(record.code + ' filled · ' + units(Store.unitsIn(record)) + ' dispensed');
    renderDashboard();
    renderStock();
    go('dashboard');
  });

  /* Manual shutter: force an immediate decode attempt on the current frame. */
  $('#shutter').addEventListener('click', function () {
    if (camera.classList.contains('is-locked')) return;
    if (!stream) { openCamera(); return; }
    scanner.scanOnce().then(function (hit) {
      if (hit) onDecoded(hit);
      else toast('Nothing readable in frame — hold the code steady inside it');
    }).catch(function (err) {
      toast(err.message || 'Could not read the frame');
    });
  });

  function setFlash(on) {
    flashOn = on;
    camera.classList.toggle('is-flash', on);
    $('#flash-toggle').setAttribute('aria-pressed', String(on));
    $('#flash-icon').innerHTML = '<use href="' + (on ? '#i-flash' : '#i-flash-off') + '"/>';

    if (stream) {
      var track = stream.getVideoTracks()[0];
      var caps = track && track.getCapabilities ? track.getCapabilities() : null;
      if (caps && caps.torch) {
        track.applyConstraints({ advanced: [{ torch: on }] }).catch(function () {});
      }
    }
  }

  $('#flash-toggle').addEventListener('click', function () {
    if (!stream) { toast('Start the camera first'); return; }
    var track = stream.getVideoTracks()[0];
    var caps = track && track.getCapabilities ? track.getCapabilities() : null;
    if (!caps || !caps.torch) {
      toast('This camera has no torch');
      return;
    }
    setFlash(!flashOn);
  });

  $('#camera-flip').addEventListener('click', function () {
    facing = facing === 'environment' ? 'user' : 'environment';
    closeCamera();
    openCamera();
    toast(facing === 'environment' ? 'Rear camera' : 'Front camera');
  });

  /* ================================================================== *
   * 3. Manual entry — multi-medicine prescriptions
   * ================================================================== */
  var V = window.PharmaVocab;
  var form = $('#rx-form');
  var draft = [];          // prescription lines being composed
  var editingIndex = -1;   // which line the sheet is editing, -1 = new
  var lastRx = null;

  function fillSelect(el, list) {
    el.innerHTML = list.map(function (o) {
      return '<option value="' + escapeHtml(o.id) + '">' + escapeHtml(o.label) + '</option>';
    }).join('');
  }
  fillSelect($('#ln-form'), V.FORMS);
  fillSelect($('#ln-packaging'), V.PACKAGINGS);
  fillSelect($('#ln-route'), V.ROUTES);

  function setFieldError(name, message, scope) {
    var root = scope || form;
    var input = root.elements[name];
    if (!input) return;
    var field = input.closest('.field');
    field.classList.toggle('is-bad', Boolean(message));
    var slot = $('[data-error-for="' + name + '"]', field);
    if (slot) slot.textContent = message || '';
  }

  form.addEventListener('input', function (event) {
    if (event.target.name) setFieldError(event.target.name, '');
  });

  function renderDraft() {
    $('#items-count').textContent = draft.length + (draft.length === 1 ? ' line' : ' lines');
    $('#items-empty').hidden = draft.length > 0;

    $('#item-list').innerHTML = draft.map(function (it, i) {
      var med = Store.findMedicine(it.medication);
      var short = [V.formLabel(it.form), V.packagingLabel(it.packaging)].filter(Boolean).join(' · ');
      var posology = [it.dose, it.frequency ? it.frequency.split(' — ')[0] : '', it.duration ? it.duration.split(' — ')[0] : '']
        .filter(Boolean).join(' · ');
      var shortfall = med && med.qty < it.qty;
      return '' +
        '<li class="itemcard' + (shortfall || !med ? ' itemcard--warn' : '') + '">' +
          '<div class="itemcard__head">' +
            '<p class="itemcard__name">' + escapeHtml(it.medication) +
              (it.strength ? ' <span class="itemcard__strength">' + escapeHtml(it.strength) + '</span>' : '') + '</p>' +
            '<div class="itemcard__tools">' +
              '<button class="itemcard__btn" type="button" data-edit="' + i + '" aria-label="Edit line">' +
                '<svg class="icon icon--xs"><use href="#i-pen"/></svg></button>' +
              '<button class="itemcard__btn" type="button" data-remove="' + i + '" aria-label="Remove line">' +
                '<svg class="icon icon--xs"><use href="#i-close"/></svg></button>' +
            '</div>' +
          '</div>' +
          '<p class="itemcard__meta">' + escapeHtml(short) + ' · ' + units(it.qty) + ' · ' +
            escapeHtml(V.routeLabel(it.route)) + '</p>' +
          (posology ? '<p class="itemcard__pos">' + escapeHtml(posology) + '</p>' : '') +
          (!med ? '<p class="itemcard__warn">Not stocked here</p>'
                : shortfall ? '<p class="itemcard__warn">Only ' + med.qty + ' in stock</p>' : '') +
        '</li>';
    }).join('');
  }

  $('#item-list').addEventListener('click', function (event) {
    var edit = event.target.closest('[data-edit]');
    if (edit) { openItemSheet(Number(edit.dataset.edit)); return; }
    var remove = event.target.closest('[data-remove]');
    if (remove) {
      draft.splice(Number(remove.dataset.remove), 1);
      renderDraft();
      toast('Line removed');
    }
  });

  /* ---- line editor sheet ---- */
  var itemSheet = $('#item-sheet');
  var itemForm = $('#item-form');

  function openItemSheet(index, prefill) {
    editingIndex = index === undefined ? -1 : index;
    hideToast();
    itemForm.reset();
    $$('.field', itemForm).forEach(function (f) { f.classList.remove('is-bad'); });

    var it = editingIndex >= 0 ? draft[editingIndex] : (prefill || null);
    if (it) {
      itemForm.elements.medication.value = it.medication || '';
      itemForm.elements.strength.value = it.strength || '';
      itemForm.elements.qty.value = it.qty || '';
      itemForm.elements.form.value = it.form || 'comprime';
      itemForm.elements.packaging.value = it.packaging || 'boite';
      itemForm.elements.route.value = it.route || 'orale';
      itemForm.elements.dose.value = it.dose || '';
      itemForm.elements.frequency.value = it.frequency || '';
      itemForm.elements.duration.value = it.duration || '';
    }

    $('#item-sheet-title').textContent = editingIndex >= 0 ? 'Edit medicine' : 'Add medicine';
    $('#item-save').textContent = editingIndex >= 0 ? 'Save line' : 'Add line';
    reflectStock();

    scrim.hidden = false;
    requestAnimationFrame(function () { scrim.classList.add('is-on'); });
    itemSheet.classList.add('is-open');
    itemSheet.setAttribute('aria-hidden', 'false');
  }

  function closeItemSheet() {
    scrim.classList.remove('is-on');
    itemSheet.classList.remove('is-open');
    itemSheet.setAttribute('aria-hidden', 'true');
    setTimeout(function () { if (!stockSheet.classList.contains('is-open')) scrim.hidden = true; }, 300);
    editingIndex = -1;
  }

  /* Selecting a catalogue medicine fills in what the pharmacy already knows
     about it, so the pharmacist types the posology rather than the packaging. */
  function applyCatalogue(name) {
    var med = Store.findMedicine(name);
    if (!med) return false;
    if (!itemForm.elements.strength.value) itemForm.elements.strength.value = med.strength || '';
    itemForm.elements.form.value = med.form || 'comprime';
    itemForm.elements.packaging.value = med.packaging || 'boite';
    itemForm.elements.route.value = Store.defaultRoute(med.form);
    return true;
  }

  function reflectStock() {
    var med = Store.findMedicine(itemForm.elements.medication.value);
    var note = $('#item-stock');
    if (!med) { note.hidden = true; return; }
    var want = Number(itemForm.elements.qty.value) || 0;
    note.hidden = false;
    note.textContent = units(med.qty) + ' in stock' +
      (want > med.qty ? ' — short by ' + (want - med.qty) : '') +
      ' · barcode ' + med.barcode;
  }

  itemForm.addEventListener('input', function (event) {
    if (event.target.name) setFieldError(event.target.name, '', itemForm);
    if (event.target.name === 'medication') applyCatalogue(event.target.value);
    if (event.target.name === 'medication' || event.target.name === 'qty') reflectStock();
  });

  itemForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var it = {
      medication: itemForm.elements.medication.value.trim(),
      strength: itemForm.elements.strength.value.trim(),
      form: itemForm.elements.form.value,
      packaging: itemForm.elements.packaging.value,
      qty: Number(itemForm.elements.qty.value),
      route: itemForm.elements.route.value,
      dose: itemForm.elements.dose.value.trim(),
      frequency: itemForm.elements.frequency.value.trim(),
      duration: itemForm.elements.duration.value.trim()
    };

    var ok = true;
    if (!it.medication) { setFieldError('medication', 'Medicine is required', itemForm); ok = false; }
    if (!it.qty || it.qty < 1) { setFieldError('qty', 'Enter 1 or more', itemForm); ok = false; }
    if (!it.dose) { setFieldError('dose', 'Dose is required', itemForm); ok = false; }
    if (!it.frequency) { setFieldError('frequency', 'Frequency is required', itemForm); ok = false; }
    if (!ok) return;

    if (editingIndex >= 0) draft[editingIndex] = it;
    else draft.push(it);

    closeItemSheet();
    renderDraft();
    toast(editingIndex >= 0 ? 'Line updated' : it.medication + ' added');
  });

  $('#item-add').addEventListener('click', function () { openItemSheet(); });
  $('#item-cancel').addEventListener('click', closeItemSheet);

  /* Barcode entry points: from the screen, and from inside the line sheet. */
  $('#item-scan').addEventListener('click', function () { beginBarcodeLookup(false); });
  $('#ln-scan').addEventListener('click', function () { beginBarcodeLookup(true); });

  function beginBarcodeLookup(fromSheet) {
    barcodeIntent = fromSheet ? 'sheet' : 'draft';
    if (fromSheet) closeItemSheet();
    go('scanner');
    toast('Point the camera at the medicine barcode');
  }

  /* ---- generate the prescription code ---- */
  $('#rx-generate').addEventListener('click', function () {
    var patient = form.elements.patient.value.trim();
    var prescriber = form.elements.prescriber.value.trim();

    if (!patient) {
      setFieldError('patient', 'Patient name is required');
      toast('Enter the patient name');
      return;
    }
    if (!draft.length) {
      toast('Add at least one medicine');
      return;
    }

    var record = Store.createPrescription({
      patient: patient, prescriber: prescriber, items: draft.slice(), source: 'manual'
    });

    var payload = buildPayload(record);
    try {
      $('#qr-canvas').innerHTML = window.QRCodeGen.toSvg(payload, { quietZone: 2 });
    } catch (err) {
      toast(err.message);
      return;
    }

    lastRx = { record: record, payload: payload };
    $('#qr-code-text').textContent = record.code;
    $('#qr-meta').textContent = record.items.length +
      (record.items.length === 1 ? ' medicine' : ' medicines') + ' · ' +
      units(Store.unitsIn(record)) + ' total\nIssued for ' + record.patient;

    $('#qr-lines').innerHTML = record.items.map(function (it) {
      return '<li><b>' + escapeHtml(it.medication) + '</b> ' + escapeHtml(it.strength || '') +
        '<br>' + escapeHtml(V.formLabel(it.form)) + ' · ' + it.qty + ' units · ' +
        escapeHtml(V.routeLabel(it.route)) +
        (it.dose ? '<br>' + escapeHtml(it.dose) : '') +
        (it.frequency ? ' · ' + escapeHtml(it.frequency.split(' — ')[0]) : '') +
        (it.duration ? ' · ' + escapeHtml(it.duration.split(' — ')[0]) : '') +
        '</li>';
    }).join('');

    $('#qr-result').hidden = false;
    $('#manual-hint').hidden = true;
    $('#qr-result').scrollIntoView({ behavior: 'smooth', block: 'end' });
    toast('Prescription ' + record.code + ' created — scan it to dispense');

    draft = [];
    renderDraft();
    form.reset();
    renderDashboard();
  });

  /* PC2 payload: one pipe-delimited field per line, tildes inside a line. */
  function buildPayload(record) {
    var head = ['PC2', record.code, record.patient, record.prescriber || ''];
    var lines = record.items.map(function (it) {
      return [it.medication, it.strength, it.form, it.packaging, it.qty,
              it.route, it.dose, it.frequency, it.duration]
        .map(function (v) { return String(v == null ? '' : v).replace(/[|~]/g, ' '); })
        .join('~');
    });
    return head.concat(lines).join('|');
  }

  $('#qr-print').addEventListener('click', function () {
    if (!lastRx) return;
    if (navigator.share) {
      navigator.share({
        title: 'PharmaCheck prescription ' + lastRx.record.code,
        text: lastRx.payload
      }).catch(function () { printCode(); });
      return;
    }
    printCode();
  });

  function printCode() {
    var r = lastRx.record;
    var rows = r.items.map(function (it, i) {
      return '<div class="ps-item">' +
        '<p class="ps-item__name">' + (i + 1) + '. ' + escapeHtml(it.medication) + ' ' + escapeHtml(it.strength || '') + '</p>' +
        '<p class="ps-item__line">' + escapeHtml(V.formLabel(it.form)) + ' — ' + escapeHtml(V.packagingLabel(it.packaging)) +
          ' — ' + it.qty + ' units</p>' +
        '<p class="ps-item__line">' + escapeHtml(it.dose) + ', ' + escapeHtml(it.frequency) +
          (it.duration ? ', ' + escapeHtml(it.duration) : '') +
          ' — voie ' + escapeHtml(V.routeLabel(it.route)) + '</p>' +
        '</div>';
    }).join('');

    $('#printsheet').innerHTML =
      '<h1>PharmaCheck Prescription</h1>' +
      '<p class="ps-sub">' + escapeHtml(r.code) + '</p>' +
      window.QRCodeGen.toSvg(lastRx.payload, { quietZone: 2 }) +
      '<dl><div><dt>Patient</dt><dd>' + escapeHtml(r.patient) + '</dd></div>' +
      (r.prescriber ? '<div><dt>Prescriber</dt><dd>' + escapeHtml(r.prescriber) + '</dd></div>' : '') +
      '<div><dt>Issued</dt><dd>' + escapeHtml(new Date(r.createdAt).toLocaleString()) + '</dd></div></dl>' +
      '<div class="ps-items">' + rows + '</div>';
    window.print();
  }

  /* ================================================================== *
   * 4. Inventory
   * ================================================================== */
  var listEl = $('#stock-list');
  var filter = 'all';
  var sortBy = 'name-asc';

  function expiryTime(item) {
    var parts = String(item.expiry || '').split('/');
    if (parts.length !== 2) return Infinity;
    return new Date(Number(parts[1]), Number(parts[0]) - 1, 1).getTime();
  }

  function isExpiring(item) {
    var when = expiryTime(item);
    if (!isFinite(when)) return false;
    var months = (new Date(when).getFullYear() - new Date().getFullYear()) * 12 +
                 (new Date(when).getMonth() - new Date().getMonth());
    return months <= 12;
  }

  var SORTS = {
    'name-asc':   function (a, b) { return a.name.localeCompare(b.name); },
    'name-desc':  function (a, b) { return b.name.localeCompare(a.name); },
    'qty-asc':    function (a, b) { return a.qty - b.qty || a.name.localeCompare(b.name); },
    'qty-desc':   function (a, b) { return b.qty - a.qty || a.name.localeCompare(b.name); },
    'expiry-asc': function (a, b) { return expiryTime(a) - expiryTime(b) || a.name.localeCompare(b.name); },
    'expiry-desc':function (a, b) { return expiryTime(b) - expiryTime(a) || a.name.localeCompare(b.name); },
    // How far below the reorder level each item sits — the restocking order.
    'short-desc': function (a, b) {
      return (b.reorder - b.qty) - (a.reorder - a.qty) || a.name.localeCompare(b.name);
    },
    'value-desc': function (a, b) { return (b.qty * b.cost) - (a.qty * a.cost); }
  };

  function renderStock() {
    var query = $('#inv-search').value.trim().toLowerCase();
    var all = Store.medicines();

    var rows = all.filter(function (item) {
      if (query && item.name.toLowerCase().indexOf(query) === -1 &&
          String(item.barcode || '').indexOf(query) === -1) return false;
      if (filter === 'low') return Store.isLow(item);
      if (filter === 'expiring') return isExpiring(item);
      return true;
    }).sort(SORTS[sortBy] || SORTS['name-asc']);

    listEl.innerHTML = rows.map(function (item) {
      var low = Store.isLow(item);
      return '' +
        '<li class="stockrow ' + (low ? 'stockrow--low' : 'stockrow--ok') + '" data-name="' + escapeHtml(item.name) + '">' +
          '<div class="stockrow__top">' +
            '<span class="stockrow__dot" aria-hidden="true"></span>' +
            '<div class="stockrow__body">' +
              '<p class="stockrow__name">' + escapeHtml(item.name) +
                (item.strength ? ' <span class="stockrow__strength">' + escapeHtml(item.strength) + '</span>' : '') +
              '</p>' +
              '<p class="stockrow__meta">' +
                '<span>' + escapeHtml(V.formLabel(item.form)) + ' · ' + escapeHtml(item.batch) + '</span>' +
                '<span>Exp ' + escapeHtml(item.expiry) + '</span>' +
                (low ? '<span class="stockrow__warn">' +
                       '<svg class="icon icon--xs"><use href="#i-alert"/></svg>Low Stock</span>' : '') +
              '</p>' +
            '</div>' +
          '</div>' +
          '<div class="stepper">' +
            '<button class="stepper__btn" type="button" data-step="-1" aria-label="Take one unit of ' + escapeHtml(item.name) + '">' +
              '<svg class="icon icon--xs"><use href="#i-minus"/></svg></button>' +
            '<button class="stepper__value" type="button" data-adjust aria-label="Adjust stock for ' + escapeHtml(item.name) + '">' +
              '<span class="stepper__qty">' + item.qty + '</span>' +
              '<span class="stepper__unit">' + (low ? 'reorder ' + item.reorder : 'in stock') + '</span>' +
            '</button>' +
            '<button class="stepper__btn" type="button" data-step="1" aria-label="Add one unit of ' + escapeHtml(item.name) + '">' +
              '<svg class="icon icon--xs"><use href="#i-plus"/></svg></button>' +
          '</div>' +
        '</li>';
    }).join('');

    $('#stock-empty').hidden = rows.length > 0;
    $('#inv-summary').textContent =
      all.length + ' medicines · ' + Store.lowStockCount() + ' below reorder level';
  }

  $('#inv-search').addEventListener('input', renderStock);
  $('#inv-sort').addEventListener('change', function () {
    sortBy = this.value;
    renderStock();
  });

  $$('.chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      $$('.chip').forEach(function (other) {
        other.classList.toggle('is-on', other === chip);
        other.setAttribute('aria-selected', String(other === chip));
      });
      filter = chip.dataset.filter;
      renderStock();
    });
  });

  /* ---- stock steppers -------------------------------------------------
     A tap moves one unit; holding repeats, accelerating, so a delivery of
     120 does not mean 120 taps. Only the touched row is re-rendered while
     the hold runs, otherwise the button would be ripped out from under the
     finger on every repeat. */
  var holdTimer = null;
  var holdCount = 0;

  function adjust(name, delta) {
    var med = Store.findMedicine(name);
    if (!med) return null;
    var next = Math.max(0, med.qty + delta);
    if (next === med.qty) return med;
    med.qty = next;
    Store.save();
    return med;
  }

  function paintRow(row, med) {
    var low = Store.isLow(med);
    row.classList.toggle('stockrow--low', low);
    row.classList.toggle('stockrow--ok', !low);
    $('.stepper__qty', row).textContent = med.qty;
    $('.stepper__unit', row).textContent = low ? 'reorder ' + med.reorder : 'in stock';
    var warn = $('.stockrow__warn', row);
    if (low && !warn) {
      $('.stockrow__meta', row).insertAdjacentHTML('beforeend',
        '<span class="stockrow__warn"><svg class="icon icon--xs"><use href="#i-alert"/></svg>Low Stock</span>');
    } else if (!low && warn) {
      warn.remove();
    }
  }

  function stopHold() {
    clearTimeout(holdTimer);
    holdTimer = null;
    if (holdCount) {
      // Re-sort and refresh totals once the finger lifts.
      renderStock();
      renderDashboard();
      holdCount = 0;
    }
  }

  listEl.addEventListener('pointerdown', function (event) {
    var btn = event.target.closest('[data-step]');
    if (!btn) return;
    var row = btn.closest('.stockrow');
    var name = row.dataset.name;
    var delta = Number(btn.dataset.step);
    var elapsed = 0;

    function step() {
      holdCount++;
      // Accelerate: single units at first, then 5s, then 10s.
      var size = holdCount > 20 ? 10 : holdCount > 8 ? 5 : 1;
      var med = adjust(name, delta * size);
      if (!med) return;
      paintRow(row, med);
      toast((delta > 0 ? 'Added ' : 'Taken ') + size + ' · ' + med.name + ' now ' + units(med.qty));
      if (navigator.vibrate) navigator.vibrate(8);

      elapsed = elapsed ? Math.max(70, elapsed * 0.82) : 420;
      holdTimer = setTimeout(step, elapsed);
    }

    step();
    event.preventDefault();
  });

  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (evt) {
    listEl.addEventListener(evt, stopHold);
  });
  window.addEventListener('blur', stopHold);

  /* Tapping the number opens the sheet for a precise amount. */
  listEl.addEventListener('click', function (event) {
    var pad = event.target.closest('[data-adjust]');
    if (!pad) return;
    var name = pad.closest('.stockrow').dataset.name;
    openStockSheet(name);
  });

  /* ---- add / adjust stock sheet ---- */
  var stockSheet = $('#stock-sheet');
  var scrim = $('#scrim');
  var stockForm = $('#stock-form');

  function openStockSheet(prefillName) {
    hideToast();
    stockForm.reset();
    $$('.field', stockForm).forEach(function (f) { f.classList.remove('is-bad'); });
    if (prefillName) stockForm.elements.name.value = prefillName;

    scrim.hidden = false;
    requestAnimationFrame(function () { scrim.classList.add('is-on'); });
    stockSheet.classList.add('is-open');
    stockSheet.setAttribute('aria-hidden', 'false');
    setTimeout(function () { $('#s-qty').focus(); }, 260);
  }

  function closeStockSheet() {
    scrim.classList.remove('is-on');
    stockSheet.classList.remove('is-open');
    stockSheet.setAttribute('aria-hidden', 'true');
    setTimeout(function () { if (!itemSheet.classList.contains('is-open')) scrim.hidden = true; }, 300);
    stockForm.reset();
    $$('.field', stockForm).forEach(function (f) { f.classList.remove('is-bad'); });
  }

  $('#fab-add').addEventListener('click', function () { openStockSheet(); });
  $('#stock-cancel').addEventListener('click', closeStockSheet);
  scrim.addEventListener('click', function () {
    if (stockSheet.classList.contains('is-open')) closeStockSheet();
    if (itemSheet.classList.contains('is-open')) closeItemSheet();
  });

  stockForm.addEventListener('input', function (event) {
    var field = event.target.closest('.field');
    if (field) field.classList.remove('is-bad');
  });

  stockForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var name = stockForm.elements.name.value.trim();
    var qty = Number(stockForm.elements.qty.value);
    var ok = true;

    if (!name) { markBad(stockForm.elements.name, 'Medicine name is required'); ok = false; }
    if (!qty || qty === 0) { markBad(stockForm.elements.qty, 'Enter an amount'); ok = false; }
    if (!ok) return;

    var item;
    if (qty < 0) {
      item = adjust(name, qty);
      if (!item) { markBad(stockForm.elements.name, 'Not in the catalogue'); return; }
      toast('Taken ' + Math.abs(qty) + ' · ' + item.name + ' now ' + units(item.qty));
    } else {
      item = Store.addStock(name, qty);
      toast('Added ' + qty + ' · ' + item.name + ' now ' + units(item.qty));
    }

    closeStockSheet();
    renderStock();
    renderDashboard();
  });

  function markBad(input, message) {
    var field = input.closest('.field');
    field.classList.add('is-bad');
    var slot = $('.field__error', field);
    if (slot) slot.textContent = message;
  }

  /* ---- type-ahead ---------------------------------------------------
     Replaces <datalist>, which Android draws as an opaque OS list that
     ignores the app's styling entirely. */
  var AC = window.PharmaAutocomplete;

  function medicineSource(query) {
    return AC.rank(Store.medicines(), query, function (m) { return m.name; })
      .slice(0, 40)
      .map(function (m) {
        return {
          value: m.name,
          label: m.name,
          meta: [m.strength, V.formLabel(m.form), V.packagingLabel(m.packaging)]
            .filter(Boolean).join(' · '),
          tag: units(m.qty),
          tagWarn: Store.isLow(m),
          medicine: m
        };
      });
  }

  function plainSource(values) {
    return function (query) {
      return AC.rank(values, query, function (v) { return v; })
        .slice(0, 20)
        .map(function (v) { return { value: v, label: v }; });
    };
  }

  function setUpTypeAhead() {
    AC.attach($('#ln-name'), {
      source: medicineSource,
      emptyText: 'Not in the catalogue — it will be added as a new medicine',
      onPick: function (hit) { applyCatalogue(hit.value); reflectStock(); }
    });
    AC.attach($('#s-name'), {
      source: medicineSource,
      emptyText: 'Not in the catalogue — adding stock will create it'
    });
    AC.attach($('#ln-dose'), { source: plainSource(V.DOSES) });
    AC.attach($('#ln-frequency'), { source: plainSource(V.FREQUENCIES) });
    AC.attach($('#ln-duration'), { source: plainSource(V.DURATIONS) });
  }

  /* ================================================================== *
   * 5. Financial reports
   * ================================================================== */
  var activePeriod = 'weekly';

  function renderReports(period) {
    var data = Store.report(period);

    $('#profit-value').textContent = money(data.profit);
    $('#profit-trend').textContent = data.change === null
      ? 'No comparable prior period'
      : (data.change >= 0 ? '+' : '') + data.change.toFixed(1) + '% vs previous period';
    $('.profit__trend').style.display = '';

    var from = new Date(data.rangeFrom);
    var to = new Date(data.rangeTo - 1);
    $('#profit-range').textContent = from.toLocaleDateString([], { day: 'numeric', month: 'short' }) +
      ' – ' + to.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

    $('#revenue-value').textContent = money(data.revenue, 0);
    $('#revenue-meta').textContent = data.count.toLocaleString() +
      (data.count === 1 ? ' prescription' : ' prescriptions');
    $('#cogs-value').textContent = money(data.cogs, 0);
    $('#cogs-meta').textContent = data.cogsShare.toFixed(1) + '% of revenue';
    $('.chartcard__hint').textContent = data.chartLabel;

    renderChart(data.bars);

    $('#rank-list').innerHTML = data.items.length ? data.items.map(function (item, i) {
      return '' +
        '<li class="rankrow">' +
          '<span class="rankrow__no">' + (i + 1) + '</span>' +
          '<div class="rankrow__body">' +
            '<p class="rankrow__name">' + escapeHtml(item.name) + '</p>' +
            '<p class="rankrow__meta">' + money(item.revenue, 0) + ' revenue · ' +
              item.units.toLocaleString() + ' units</p>' +
          '</div>' +
          '<span class="rankrow__margin">' + item.margin + '%</span>' +
        '</li>';
    }).join('') : '<li class="rankrow"><p class="rankrow__meta">No sales in this period.</p></li>';
  }

  function renderChart(bars) {
    var W = 300, H = 150, padTop = 18, padBottom = 26;
    var plot = H - padTop - padBottom;
    var slot = W / bars.length;
    var barW = 30;
    var max = Math.max.apply(null, bars.map(function (b) { return b.value; })) || 1;
    var peak = bars.reduce(function (best, b) { return b.value > best.value ? b : best; });

    var svg = ['<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Revenue trend">'];
    [0, 0.5, 1].forEach(function (f) {
      var y = padTop + plot * f;
      svg.push('<line class="grid-line" x1="0" y1="' + y + '" x2="' + W + '" y2="' + y + '"/>');
    });

    bars.forEach(function (bar, i) {
      var height = Math.max(3, (bar.value / max) * plot);
      var x = slot * i + (slot - barW) / 2;
      var y = padTop + plot - height;
      var fill = (bar === peak && bar.value > 0) ? 'url(#barPeak)' : '#C9E0FA';
      var label = bar.value >= 1000
        ? '$' + (bar.value / 1000).toFixed(1) + 'k'
        : '$' + Math.round(bar.value);

      svg.push('<rect class="bar" x="' + x + '" y="' + y + '" width="' + barW +
        '" height="' + height + '" rx="8" fill="' + fill + '"/>');
      svg.push('<text class="bar-value" x="' + (x + barW / 2) + '" y="' + (y - 6) +
        '" text-anchor="middle">' + label + '</text>');
      svg.push('<text class="bar-label" x="' + (x + barW / 2) + '" y="' + (H - 6) +
        '" text-anchor="middle">' + escapeHtml(bar.label) + '</text>');
    });

    svg.push('<defs><linearGradient id="barPeak" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#4A9BF7"/><stop offset="100%" stop-color="#1360C9"/>' +
      '</linearGradient></defs></svg>');

    $('#chart').innerHTML = svg.join('');
  }

  var segButtons = $$('.segmented__btn');
  var segPill = $('#segpill');

  function moveSegPill() {
    var active = $('.segmented__btn.is-on');
    if (!active || !active.offsetWidth) return;
    segPill.style.width = active.offsetWidth + 'px';
    segPill.style.transform = 'translateX(' + active.offsetLeft + 'px)';
  }

  segButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      segButtons.forEach(function (other) {
        other.classList.toggle('is-on', other === button);
        other.setAttribute('aria-selected', String(other === button));
      });
      activePeriod = button.dataset.period;
      moveSegPill();
      renderReports(activePeriod);
    });
  });

  window.addEventListener('resize', moveSegPill);

  /* ================================================================== *
   * Boot
   * ================================================================== */
  segButtons.forEach(function (b) {
    b.classList.toggle('is-on', b.dataset.period === activePeriod);
    b.setAttribute('aria-selected', String(b.dataset.period === activePeriod));
  });

  if (!isNative) window.__pharmacheckBuild({ version: '1.0.0', channel: 'web', embedded: true });

  Store.load();
  setUpTypeAhead();
  renderStock();
  renderDashboard();
  renderReports(activePeriod);
  requestAnimationFrame(moveSegPill);
  go('dashboard');
})();
