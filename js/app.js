/* =====================================================================
   PharmaCheck — application logic
   Screen routing, camera scanner, prescription code generation,
   inventory filtering and the reporting dashboard.
   ===================================================================== */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

  var phone = $('.phone');

  /* ------------------------------------------------------------------ *
   * Toast
   * ------------------------------------------------------------------ */
  var toastEl = $('#toast');
  var toastTimer;
  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 2600);
  }

  /* Sheets slide up over the same corner the toast occupies, so anything
     still showing is dismissed as one opens. */
  function hideToast() {
    clearTimeout(toastTimer);
    toastEl.classList.remove('is-on');
  }

  /* ------------------------------------------------------------------ *
   * Status bar clock
   * ------------------------------------------------------------------ */
  function tickClock() {
    var now = new Date();
    $('#clock').textContent = now.toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit'
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
    dashboard: 'dashboard',
    scanner: 'scanner',
    manual: 'scanner',   // manual entry lives under the Prescriptions tab
    inventory: 'inventory',
    reports: 'reports'
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

    if (name === 'scanner') startCamera();
    else stopCamera();

    if (name === 'reports') {
      renderReports(activePeriod);
      // The segmented control can only be measured once its screen is shown.
      requestAnimationFrame(moveSegPill);
    }

    var screen = $('#screen-' + name);
    if (screen.classList.contains('screen--scroll')) screen.scrollTop = 0;

    current = name;
  }

  document.addEventListener('click', function (event) {
    var trigger = event.target.closest('[data-go]');
    if (trigger) {
      go(trigger.dataset.go);
      return;
    }
    var teller = event.target.closest('[data-toast]');
    if (teller) toast(teller.dataset.toast);
  });

  /* ------------------------------------------------------------------ *
   * Screen 2 — Prescription scanner
   * ------------------------------------------------------------------ */
  var camera = $('.camera');
  var video = $('#camera-feed');
  var sheet = $('#scan-sheet');
  var stream = null;
  var facing = 'environment';
  var flashOn = false;

  var DEMO_SCAN = {
    code: 'PC-2026-0481',
    patient: 'Maria Gonzalez',
    medication: 'Amoxicillin 500mg',
    dosage: '1 capsule, 3× daily',
    quantity: '21 capsules',
    units: 21,
    prescriber: 'Dr. E. Okafor'
  };

  // The QR code shown on the simulated prescription is genuinely encoded.
  $('#mock-qr').innerHTML = window.QRCodeGen.toSvg(
    ['PC1', DEMO_SCAN.code, DEMO_SCAN.patient, DEMO_SCAN.medication,
     DEMO_SCAN.dosage, DEMO_SCAN.quantity].join('|'),
    { quietZone: 1, dark: '#151A22' }
  );

  function startCamera() {
    if (stream || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing },
      audio: false
    }).then(function (media) {
      stream = media;
      video.srcObject = media;
      camera.classList.add('is-live');
      $('#camera-source').textContent = 'Live camera';
    }).catch(function () {
      /* No camera, or permission denied — the simulated feed stays up. */
      camera.classList.remove('is-live');
      $('#camera-source').textContent = 'Simulated feed';
    });
  }

  function stopCamera() {
    if (!stream) return;
    stream.getTracks().forEach(function (track) { track.stop(); });
    stream = null;
    video.srcObject = null;
    camera.classList.remove('is-live');
    setFlash(false);
  }

  function setFlash(on) {
    flashOn = on;
    camera.classList.toggle('is-flash', on);
    var button = $('#flash-toggle');
    button.setAttribute('aria-pressed', String(on));
    $('#flash-icon').innerHTML =
      '<use href="' + (on ? '#i-flash' : '#i-flash-off') + '"/>';

    // Drive the real torch when the device exposes one.
    if (stream) {
      var track = stream.getVideoTracks()[0];
      var caps = track && track.getCapabilities ? track.getCapabilities() : null;
      if (caps && caps.torch) {
        track.applyConstraints({ advanced: [{ torch: on }] }).catch(function () {});
      }
    }
  }

  $('#flash-toggle').addEventListener('click', function () {
    setFlash(!flashOn);
    toast(flashOn ? 'Flash on' : 'Flash off');
  });

  $('#camera-flip').addEventListener('click', function () {
    facing = facing === 'environment' ? 'user' : 'environment';
    stopCamera();
    startCamera();
    toast(facing === 'environment' ? 'Rear camera' : 'Front camera');
  });

  function openScanResult() {
    hideToast();
    camera.classList.add('is-locked');
    $('#camera-hint').textContent = 'Prescription code recognised';
    $('#scan-code').textContent = DEMO_SCAN.code;
    setTimeout(function () {
      sheet.classList.add('is-open');
      sheet.setAttribute('aria-hidden', 'false');
    }, 620);
  }

  function resetScanner() {
    sheet.classList.remove('is-open');
    sheet.setAttribute('aria-hidden', 'true');
    camera.classList.remove('is-locked');
    $('#camera-hint').textContent = 'Align QR Code within the frame';
  }

  $('#shutter').addEventListener('click', function () {
    if (camera.classList.contains('is-locked')) return;
    if (navigator.vibrate) navigator.vibrate(18);
    openScanResult();
  });

  $('#scan-dismiss').addEventListener('click', resetScanner);

  $('#scan-fill').addEventListener('click', function () {
    resetScanner();
    if (!dispense(DEMO_SCAN.medication, DEMO_SCAN.units)) return;
    toast('Prescription ' + DEMO_SCAN.code + ' filled for ' + DEMO_SCAN.patient);
    go('dashboard');
  });

  /* ------------------------------------------------------------------ *
   * Screen 3 — Manual entry & code generator
   * ------------------------------------------------------------------ */
  var form = $('#rx-form');
  var lastRx = null;

  function setFieldError(name, message) {
    var input = form.elements[name];
    var field = input.closest('.field');
    var slot = $('[data-error-for="' + name + '"]', field);
    field.classList.toggle('is-bad', Boolean(message));
    if (slot) slot.textContent = message || '';
  }

  form.addEventListener('input', function (event) {
    if (event.target.name) setFieldError(event.target.name, '');
  });

  function nextCode() {
    var seq = Number(localStorage.getItem('pharmacheck.seq') || 480) + 1;
    try { localStorage.setItem('pharmacheck.seq', String(seq)); } catch (e) { /* private mode */ }
    return 'PC-' + new Date().getFullYear() + '-' + String(seq).padStart(4, '0');
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();

    var values = {
      patient: form.elements.patient.value.trim(),
      medication: form.elements.medication.value.trim(),
      dosage: form.elements.dosage.value.trim(),
      quantity: form.elements.quantity.value.trim()
    };

    var ok = true;
    if (!values.patient) { setFieldError('patient', 'Patient name is required'); ok = false; }
    if (!values.medication) { setFieldError('medication', 'Medication name is required'); ok = false; }
    if (!values.dosage) { setFieldError('dosage', 'Dosage is required'); ok = false; }
    if (!values.quantity || Number(values.quantity) < 1) {
      setFieldError('quantity', 'Enter a quantity of 1 or more');
      ok = false;
    }
    if (!ok) {
      toast('Please complete the highlighted fields');
      return;
    }

    var code = nextCode();
    var payload = ['PC1', code, values.patient, values.medication,
                   values.dosage, values.quantity].join('|');

    try {
      $('#qr-canvas').innerHTML = window.QRCodeGen.toSvg(payload, { quietZone: 2 });
    } catch (err) {
      toast(err.message);
      return;
    }

    lastRx = { code: code, payload: payload, values: values };
    $('#qr-code-text').textContent = code;
    $('#qr-meta').textContent =
      values.medication + ' · ' + values.dosage + ' · ' + values.quantity + ' units\n' +
      'Issued for ' + values.patient;
    $('#qr-result').hidden = false;
    $('#manual-hint').hidden = true;
    $('#qr-result').scrollIntoView({ behavior: 'smooth', block: 'end' });
    toast('Prescription code ' + code + ' generated');
  });

  $('#qr-print').addEventListener('click', function () {
    if (!lastRx) return;

    if (navigator.share) {
      navigator.share({
        title: 'PharmaCheck prescription ' + lastRx.code,
        text: lastRx.payload
      }).catch(function () { printCode(); });
      return;
    }
    printCode();
  });

  function printCode() {
    var v = lastRx.values;
    $('#printsheet').innerHTML =
      '<h1>PharmaCheck Prescription</h1>' +
      '<p class="ps-sub">' + escapeHtml(lastRx.code) + '</p>' +
      window.QRCodeGen.toSvg(lastRx.payload, { quietZone: 2 }) +
      '<dl>' +
      row('Patient', v.patient) +
      row('Medication', v.medication) +
      row('Dosage', v.dosage) +
      row('Quantity', v.quantity) +
      row('Issued', new Date().toLocaleString()) +
      '</dl>';
    window.print();

    function row(label, value) {
      return '<div><dt>' + label + '</dt><dd>' + escapeHtml(value) + '</dd></div>';
    }
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  /* ------------------------------------------------------------------ *
   * Screen 4 — Inventory
   * ------------------------------------------------------------------ */
  var stock = [
    { name: 'Amoxicillin 500mg',   form: 'Capsules', qty: 34,  reorder: 40,  batch: 'AMX-2291', expiry: '03/2027' },
    { name: 'Atorvastatin 20mg',   form: 'Tablets',  qty: 264, reorder: 60,  batch: 'ATV-1180', expiry: '11/2027' },
    { name: 'Metformin 850mg',     form: 'Tablets',  qty: 412, reorder: 100, batch: 'MET-3320', expiry: '06/2028' },
    { name: 'Salbutamol Inhaler',  form: 'Inhaler',  qty: 7,   reorder: 25,  batch: 'SAL-0442', expiry: '01/2027' },
    { name: 'Omeprazole 20mg',     form: 'Capsules', qty: 156, reorder: 50,  batch: 'OMP-7715', expiry: '09/2026' },
    { name: 'Lisinopril 10mg',     form: 'Tablets',  qty: 92,  reorder: 60,  batch: 'LIS-2043', expiry: '04/2028' },
    { name: 'Ibuprofen 400mg',     form: 'Tablets',  qty: 31,  reorder: 80,  batch: 'IBU-9931', expiry: '12/2026' },
    { name: 'Cetirizine 10mg',     form: 'Tablets',  qty: 208, reorder: 45,  batch: 'CET-5507', expiry: '08/2028' },
    { name: 'Insulin Glargine',    form: 'Pens',     qty: 12,  reorder: 20,  batch: 'INS-8812', expiry: '02/2027' },
    { name: 'Paracetamol 500mg',   form: 'Tablets',  qty: 640, reorder: 150, batch: 'PAR-1002', expiry: '10/2028' },
    { name: 'Azithromycin 250mg',  form: 'Tablets',  qty: 44,  reorder: 40,  batch: 'AZI-6634', expiry: '05/2027' },
    { name: 'Warfarin 5mg',        form: 'Tablets',  qty: 9,   reorder: 30,  batch: 'WAR-4419', expiry: '07/2026' }
  ];

  var listEl = $('#stock-list');
  var filter = 'all';
  var lowStockCount = 0;

  function isLow(item) { return item.qty < item.reorder; }

  function isExpiring(item) {
    var parts = item.expiry.split('/');
    var when = new Date(Number(parts[1]), Number(parts[0]) - 1, 1);
    var months = (when.getFullYear() - new Date().getFullYear()) * 12 +
                 (when.getMonth() - new Date().getMonth());
    return months <= 12;
  }

  function renderStock() {
    var query = $('#inv-search').value.trim().toLowerCase();

    var rows = stock.filter(function (item) {
      if (query && item.name.toLowerCase().indexOf(query) === -1) return false;
      if (filter === 'low') return isLow(item);
      if (filter === 'expiring') return isExpiring(item);
      return true;
    });

    listEl.innerHTML = rows.map(function (item) {
      var low = isLow(item);
      return '' +
        '<li class="stockrow ' + (low ? 'stockrow--low' : 'stockrow--ok') + '">' +
          '<span class="stockrow__dot" aria-hidden="true"></span>' +
          '<div class="stockrow__body">' +
            '<p class="stockrow__name">' + escapeHtml(item.name) + '</p>' +
            '<p class="stockrow__meta">' +
              '<span>' + escapeHtml(item.form) + ' · ' + escapeHtml(item.batch) + '</span>' +
              '<span>Exp ' + escapeHtml(item.expiry) + '</span>' +
              (low
                ? '<span class="stockrow__warn">' +
                    '<svg class="icon icon--xs"><use href="#i-alert"/></svg>Low Stock</span>'
                : '') +
            '</p>' +
          '</div>' +
          '<div class="stockrow__right">' +
            '<p class="stockrow__qty">' + item.qty + '</p>' +
            '<p class="stockrow__unit">' + (low ? 'reorder ' + item.reorder : 'in stock') + '</p>' +
          '</div>' +
        '</li>';
    }).join('');

    $('#stock-empty').hidden = rows.length > 0;

    lowStockCount = stock.filter(isLow).length;
    var lowCount = lowStockCount;
    $('#inv-summary').textContent =
      stock.length + ' medicines · ' + lowCount + ' below reorder level';
    // Keep the dashboard's low-stock metric in step with the real list.
    $('#dash-low').textContent = lowCount;
  }

  $('#inv-search').addEventListener('input', renderStock);

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

  /* Filling a prescription draws the units down from stock. A pharmacy
     cannot dispense what it does not have, so a short shelf blocks the fill
     rather than silently bottoming out at zero. */
  function dispense(medication, units) {
    var item = stock.find(function (entry) { return entry.name === medication; });
    if (!item) return true;
    if (item.qty < units) {
      toast('Only ' + item.qty + ' units of ' + medication + ' in stock — reorder before filling');
      return false;
    }
    item.qty -= units;
    renderStock();
    return true;
  }

  /* Add-stock sheet */
  var stockSheet = $('#stock-sheet');
  var scrim = $('#scrim');
  var stockForm = $('#stock-form');

  function openStockSheet() {
    hideToast();
    scrim.hidden = false;
    requestAnimationFrame(function () { scrim.classList.add('is-on'); });
    stockSheet.classList.add('is-open');
    stockSheet.setAttribute('aria-hidden', 'false');
    setTimeout(function () { $('#s-name').focus(); }, 260);
  }

  function closeStockSheet() {
    scrim.classList.remove('is-on');
    stockSheet.classList.remove('is-open');
    stockSheet.setAttribute('aria-hidden', 'true');
    setTimeout(function () { scrim.hidden = true; }, 300);
    stockForm.reset();
    $$('.field', stockForm).forEach(function (f) { f.classList.remove('is-bad'); });
  }

  $('#bell').addEventListener('click', function () {
    toast(lowStockCount + ' medicines below reorder level · ' +
          '3 prescriptions awaiting verification');
  });

  $('#fab-add').addEventListener('click', openStockSheet);
  $('#stock-cancel').addEventListener('click', closeStockSheet);
  scrim.addEventListener('click', closeStockSheet);

  stockForm.addEventListener('input', function (event) {
    var field = event.target.closest('.field');
    if (field) field.classList.remove('is-bad');
  });

  stockForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var name = stockForm.elements.name.value.trim();
    var qty = Number(stockForm.elements.qty.value);
    var ok = true;

    if (!name) {
      markBad(stockForm.elements.name, 'Medicine name is required');
      ok = false;
    }
    if (!qty || qty < 1) {
      markBad(stockForm.elements.qty, 'Enter 1 unit or more');
      ok = false;
    }
    if (!ok) return;

    var existing = stock.find(function (item) {
      return item.name.toLowerCase() === name.toLowerCase();
    });

    if (existing) {
      existing.qty += qty;
      toast(qty + ' units added — ' + existing.name + ' now at ' + existing.qty);
    } else {
      stock.unshift({
        name: name, form: 'Units', qty: qty, reorder: Math.max(10, Math.round(qty / 4)),
        batch: 'NEW-' + Math.floor(1000 + Math.random() * 9000), expiry: '12/2028'
      });
      toast(name + ' added to inventory');
      refreshSuggestions();
    }

    closeStockSheet();
    renderStock();
  });

  function markBad(input, message) {
    var field = input.closest('.field');
    field.classList.add('is-bad');
    var slot = $('.field__error', field);
    if (slot) slot.textContent = message;
  }

  function refreshSuggestions() {
    $('#med-suggestions').innerHTML = stock.map(function (item) {
      return '<option value="' + escapeHtml(item.name) + '"></option>';
    }).join('');
  }

  /* ------------------------------------------------------------------ *
   * Screen 5 — Financial reports
   * ------------------------------------------------------------------ */
  var REPORTS = {
    daily: {
      profit: 1284.40, trend: '+9.2% vs yesterday', range: 'Today, 08:00 – 18:00',
      revenue: 4280.00, cogs: 2995.60,
      revenueMeta: '38 transactions', cogsMeta: '70.0% of revenue',
      chartLabel: 'Last 4 days',
      bars: [{ label: 'Mon', value: 3610 }, { label: 'Tue', value: 4120 },
             { label: 'Wed', value: 3880 }, { label: 'Thu', value: 4280 }],
      items: [
        { name: 'Atorvastatin 20mg', meta: '$612 revenue', margin: 41 },
        { name: 'Insulin Glargine', meta: '$540 revenue', margin: 36 },
        { name: 'Omeprazole 20mg', meta: '$388 revenue', margin: 33 },
        { name: 'Cetirizine 10mg', meta: '$244 revenue', margin: 29 }
      ]
    },
    weekly: {
      profit: 8942.75, trend: '+12.4% vs last week', range: 'Mon 11 – Sun 17 August',
      revenue: 29680.00, cogs: 20737.25,
      revenueMeta: '264 transactions', cogsMeta: '69.9% of revenue',
      chartLabel: 'Last 4 weeks',
      bars: [{ label: 'W1', value: 24100 }, { label: 'W2', value: 26840 },
             { label: 'W3', value: 25390 }, { label: 'W4', value: 29680 }],
      items: [
        { name: 'Atorvastatin 20mg', meta: '$4,180 revenue', margin: 42 },
        { name: 'Metformin 850mg', meta: '$3,640 revenue', margin: 38 },
        { name: 'Insulin Glargine', meta: '$3,120 revenue', margin: 35 },
        { name: 'Omeprazole 20mg', meta: '$2,470 revenue', margin: 31 }
      ]
    },
    monthly: {
      profit: 37610.20, trend: '+7.8% vs last month', range: '1 – 31 August 2026',
      revenue: 124840.00, cogs: 87229.80,
      revenueMeta: '1,142 transactions', cogsMeta: '69.9% of revenue',
      chartLabel: 'Last 4 months',
      bars: [{ label: 'May', value: 108400 }, { label: 'Jun', value: 115200 },
             { label: 'Jul', value: 112750 }, { label: 'Aug', value: 124840 }],
      items: [
        { name: 'Atorvastatin 20mg', meta: '$17,900 revenue', margin: 43 },
        { name: 'Metformin 850mg', meta: '$15,240 revenue', margin: 39 },
        { name: 'Insulin Glargine', meta: '$13,880 revenue', margin: 36 },
        { name: 'Salbutamol Inhaler', meta: '$9,410 revenue', margin: 30 }
      ]
    }
  };

  var activePeriod = 'weekly';

  var money = function (value, decimals) {
    return '$' + value.toLocaleString('en-US', {
      minimumFractionDigits: decimals === undefined ? 2 : decimals,
      maximumFractionDigits: decimals === undefined ? 2 : decimals
    });
  };

  function renderReports(period) {
    var data = REPORTS[period];
    if (!data) return;

    $('#profit-value').textContent = money(data.profit);
    $('#profit-trend').textContent = data.trend;
    $('#profit-range').textContent = data.range;
    $('#revenue-value').textContent = money(data.revenue, 0);
    $('#revenue-meta').textContent = data.revenueMeta;
    $('#cogs-value').textContent = money(data.cogs, 0);
    $('#cogs-meta').textContent = data.cogsMeta;
    $('.chartcard__hint').textContent = data.chartLabel;

    renderChart(data.bars);

    $('#rank-list').innerHTML = data.items.map(function (item, index) {
      return '' +
        '<li class="rankrow">' +
          '<span class="rankrow__no">' + (index + 1) + '</span>' +
          '<div class="rankrow__body">' +
            '<p class="rankrow__name">' + escapeHtml(item.name) + '</p>' +
            '<p class="rankrow__meta">' + escapeHtml(item.meta) + '</p>' +
          '</div>' +
          '<span class="rankrow__margin">' + item.margin + '%</span>' +
        '</li>';
    }).join('');
  }

  function renderChart(bars) {
    var W = 300, H = 150;
    var padTop = 18, padBottom = 26;
    var plot = H - padTop - padBottom;
    var slot = W / bars.length;
    var barW = 30;
    var max = Math.max.apply(null, bars.map(function (b) { return b.value; }));
    var peak = bars.reduce(function (best, b) { return b.value > best.value ? b : best; });

    var svg = ['<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Sales trend">'];

    [0, 0.5, 1].forEach(function (fraction) {
      var y = padTop + plot * fraction;
      svg.push('<line class="grid-line" x1="0" y1="' + y + '" x2="' + W + '" y2="' + y + '"/>');
    });

    bars.forEach(function (bar, index) {
      var height = Math.max(4, (bar.value / max) * plot);
      var x = slot * index + (slot - barW) / 2;
      var y = padTop + plot - height;
      var isPeak = bar === peak;
      var fill = isPeak ? 'url(#barPeak)' : '#C9E0FA';

      svg.push('<rect class="bar" x="' + x + '" y="' + y + '" width="' + barW +
        '" height="' + height + '" rx="8" fill="' + fill + '"/>');
      svg.push('<text class="bar-value" x="' + (x + barW / 2) + '" y="' + (y - 6) +
        '" text-anchor="middle">' +
        (bar.value >= 1000 ? '$' + (bar.value / 1000).toFixed(1) + 'k' : '$' + bar.value) +
        '</text>');
      svg.push('<text class="bar-label" x="' + (x + barW / 2) + '" y="' + (H - 6) +
        '" text-anchor="middle">' + bar.label + '</text>');
    });

    svg.push('<defs><linearGradient id="barPeak" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#4A9BF7"/><stop offset="100%" stop-color="#1360C9"/>' +
      '</linearGradient></defs>');
    svg.push('</svg>');

    $('#chart').innerHTML = svg.join('');
  }

  var segButtons = $$('.segmented__btn');
  var segPill = $('#segpill');

  function moveSegPill() {
    var active = $('.segmented__btn.is-on');
    if (!active) return;
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

  /* The pill needs a laid-out segmented control, so position it once the
   * reports screen has been measured. */
  window.addEventListener('resize', moveSegPill);

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */
  $$('.segmented__btn').forEach(function (b) {
    b.classList.toggle('is-on', b.dataset.period === activePeriod);
    b.setAttribute('aria-selected', String(b.dataset.period === activePeriod));
  });

  refreshSuggestions();
  renderStock();
  renderReports(activePeriod);
  requestAnimationFrame(moveSegPill);
  go('dashboard');
})();
