/* =====================================================================
   PharmaCheck — data layer

   One source of truth for medicines and prescriptions, persisted to
   localStorage. Every figure the dashboard and the reports screen show is
   derived from these records; nothing on screen is a hard-coded number.

   A prescription holds one or more line items, each carrying the fields a
   real prescription separates: pharmaceutical form, packaging, strength,
   quantity, route, dose, frequency and duration.
   ===================================================================== */
(function (global) {
  'use strict';

  var KEY = 'pharmacheck.db.v4';
  var LEGACY_V3 = 'pharmacheck.db.v3';
  var LEGACY_V2 = 'pharmacheck.db.v2';
  var DAY = 86400000;

  /* Accounts and roles.
   *
   * This is a local profile switcher with a PIN, not authentication: there is
   * no server, so the PIN only stops a colleague picking up the phone and
   * billing sales to someone else. Anyone with the device can read it. Real
   * multi-user access control needs a backend, which this app does not have.
   */
  var MANAGER = 'manager';
  var VENDOR = 'vendor';

  function defaultAccounts(now) {
    return [
      { id: 'acc-1', name: 'Sarah Kaur',  role: MANAGER, pin: '1234', active: true, createdAt: now },
      { id: 'acc-2', name: 'Youssef Ben', role: VENDOR,  pin: '1111', active: true, createdAt: now },
      { id: 'acc-3', name: 'Nadia Cherif', role: VENDOR, pin: '2222', active: true, createdAt: now }
    ];
  }

  /* EAN-13 check digit, so the catalogue barcodes are genuinely scannable
     rather than 13 arbitrary digits. */
  function ean13(twelve) {
    var sum = 0;
    for (var i = 0; i < 12; i++) {
      sum += Number(twelve[i]) * (i % 2 === 0 ? 1 : 3);
    }
    return twelve + String((10 - (sum % 10)) % 10);
  }

  var CATALOGUE = [
    { name: 'Amoxicillin 500mg',  strength: '500 mg',  form: 'gelule',       packaging: 'boite',     ean: '340009412345', qty: 34,  reorder: 40,  batch: 'AMX-2291', expiry: '03/2027', price: 12.50,  cost: 7.00 },
    { name: 'Atorvastatin 20mg',  strength: '20 mg',   form: 'comprime',     packaging: 'plaquette', ean: '340009423456', qty: 264, reorder: 60,  batch: 'ATV-1180', expiry: '11/2027', price: 26.00,  cost: 13.50 },
    { name: 'Metformin 850mg',    strength: '850 mg',  form: 'comprime',     packaging: 'plaquette', ean: '340009434567', qty: 412, reorder: 100, batch: 'MET-3320', expiry: '06/2028', price: 8.00,  cost: 4.50 },
    { name: 'Salbutamol Inhaler', strength: '100 µg',  form: 'spray',        packaging: 'flacon',    ean: '340009445678', qty: 7,   reorder: 25,  batch: 'SAL-0442', expiry: '01/2027', price: 385.00, cost: 240.00 },
    { name: 'Omeprazole 20mg',    strength: '20 mg',   form: 'gelule',       packaging: 'plaquette', ean: '340009456789', qty: 156, reorder: 50,  batch: 'OMP-7715', expiry: '09/2026', price: 14.00,  cost: 8.50 },
    { name: 'Lisinopril 10mg',    strength: '10 mg',   form: 'comprime',     packaging: 'boite',     ean: '340009467890', qty: 92,  reorder: 60,  batch: 'LIS-2043', expiry: '04/2028', price: 10.50,  cost: 6.20 },
    { name: 'Ibuprofen 400mg',    strength: '400 mg',  form: 'comprime',     packaging: 'plaquette', ean: '340009478901', qty: 31,  reorder: 80,  batch: 'IBU-9931', expiry: '12/2026', price: 5.20,  cost: 2.70 },
    { name: 'Cetirizine 10mg',    strength: '10 mg',   form: 'comprime',     packaging: 'plaquette', ean: '340009489012', qty: 208, reorder: 45,  batch: 'CET-5507', expiry: '08/2028', price: 6.80,  cost: 4.30 },
    { name: 'Insulin Glargine',   strength: '100 U/mL', form: 'sol-injectable', packaging: 'seringue', ean: '340009490123', qty: 12,  reorder: 20,  batch: 'INS-8812', expiry: '02/2027', price: 1450.00, cost: 950.00 },
    { name: 'Paracetamol 500mg',  strength: '500 mg',  form: 'comprime',     packaging: 'boite',     ean: '340009501234', qty: 640, reorder: 150, batch: 'PAR-1002', expiry: '10/2028', price: 3.20,  cost: 1.60 },
    { name: 'Azithromycin 250mg', strength: '250 mg',  form: 'comprime',     packaging: 'plaquette', ean: '340009512345', qty: 44,  reorder: 40,  batch: 'AZI-6634', expiry: '05/2027', price: 52.00,  cost: 31.00 },
    { name: 'Warfarin 5mg',       strength: '5 mg',    form: 'comprime',     packaging: 'plaquette', ean: '340009523456', qty: 9,   reorder: 30,  batch: 'WAR-4419', expiry: '07/2026', price: 11.50,  cost: 6.60 },
    { name: 'Amoxicillin Syrup',  strength: '250 mg/5 mL', form: 'susp-buvable', packaging: 'flacon', ean: '340009534567', qty: 48,  reorder: 20,  batch: 'AMS-7781', expiry: '02/2027', price: 165.00,  cost: 98.00 },
    { name: 'Diclofenac Gel',     strength: '1 %',     form: 'gel',          packaging: 'tube',      ean: '340009545678', qty: 63,  reorder: 25,  batch: 'DIC-3390', expiry: '11/2027', price: 240.00,  cost: 138.00 }
  ].map(function (m) {
    m.barcode = ean13(m.ean);
    delete m.ean;
    return m;
  });

  var PATIENTS = [
    'Maria Gonzalez', 'J. Whitfield', 'A. Rahman', 'Chen Wei', 'Fatima Noor',
    'Peter Lindqvist', 'Grace Adeyemi', 'Tomas Novak', 'Aisha Khan', 'Liam O\'Connor',
    'Sofia Rossi', 'Daniel Mbeki'
  ];

  var ROUTE_FOR_FORM = {
    comprime: 'orale', gelule: 'orale', sirop: 'orale', 'sol-buvable': 'orale',
    'susp-buvable': 'orale', granules: 'orale', poudre: 'orale', gouttes: 'orale',
    suppositoire: 'rectale', ovule: 'vaginale', creme: 'cutanee', pommade: 'cutanee',
    gel: 'cutanee', lotion: 'cutanee', spray: 'inhalee', patch: 'transdermique',
    'sol-injectable': 'sc', 'susp-injectable': 'im', emulsion: 'orale'
  };

  function defaultRoute(formId) { return ROUTE_FOR_FORM[formId] || 'orale'; }

  var SEED_FREQS = ['1 fois/jour — once daily', '2 fois/jour — twice daily',
                    '3 fois/jour — three times daily', 'Au coucher — at bedtime'];
  var SEED_DURATIONS = ['7 jours — 7 days', '14 jours — 14 days', '1 mois — 1 month'];

  function lcg(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  var db = null;

  function startOfDay(ts) {
    var d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function makeItem(med, units, rand) {
    return {
      medication: med.name,
      strength: med.strength,
      form: med.form,
      packaging: med.packaging,
      qty: units,
      route: defaultRoute(med.form),
      dose: med.form === 'comprime' ? '1 comprimé' : med.form === 'gelule' ? '1 gélule' : '1 application',
      frequency: SEED_FREQS[Math.floor((rand ? rand() : 0.5) * SEED_FREQS.length)],
      duration: SEED_DURATIONS[Math.floor((rand ? rand() : 0.5) * SEED_DURATIONS.length)]
    };
  }

  function seedHistory() {
    var rand = lcg(20260814);
    var out = [];
    var now = Date.now();
    var counter = 1;

    for (var back = 124; back >= 1; back--) {
      var dayStart = startOfDay(now - back * DAY);
      var weekday = new Date(dayStart).getDay();
      var volume = (weekday === 0 ? 6 : weekday === 6 ? 14 : 22) + Math.floor(rand() * 12);

      for (var i = 0; i < volume; i++) {
        // Most prescriptions are one medicine; some carry two or three.
        var lines = rand() < 0.68 ? 1 : rand() < 0.85 ? 2 : 3;
        var items = [];
        for (var l = 0; l < lines; l++) {
          var med = CATALOGUE[Math.floor(rand() * CATALOGUE.length)];
          if (items.some(function (it) { return it.medication === med.name; })) continue;
          var units = med.price > 10 ? 1 + Math.floor(rand() * 2) : 14 + Math.floor(rand() * 46);
          items.push(makeItem(med, units, rand));
        }
        var at = dayStart + Math.floor((8 + rand() * 10) * 3600000);
        out.push({
          code: 'PC-SEED-' + String(counter++).padStart(5, '0'),
          patient: PATIENTS[Math.floor(rand() * PATIENTS.length)],
          prescriber: 'Dr. E. Okafor',
          items: items,
          status: 'filled',
          createdAt: at,
          filledAt: at,
          source: 'seed'
        });
      }
    }

    for (var p = 0; p < 3; p++) {
      var m = CATALOGUE[Math.floor(rand() * CATALOGUE.length)];
      out.push({
        code: 'PC-SEED-' + String(counter++).padStart(5, '0'),
        patient: PATIENTS[Math.floor(rand() * PATIENTS.length)],
        prescriber: 'Dr. E. Okafor',
        items: [makeItem(m, 20 + Math.floor(rand() * 20), rand)],
        status: 'issued',
        createdAt: now - Math.floor((12 + p * 40) * 60000),
        filledAt: null,
        source: 'seed'
      });
    }

    return out;
  }

  function fresh() {
    var now = Date.now();
    return {
      version: 4,
      seq: 480,
      medicines: CATALOGUE.map(function (m) { return Object.assign({}, m); }),
      prescriptions: seedHistory(),
      accounts: defaultAccounts(now),
      sales: seedSales(),
      sessionId: null
    };
  }

  /* Counter sales attributed to the seeded vendors, so a vendor's profit
     screen is not empty before they have scanned anything. */
  function seedSales() {
    var rand = lcg(770214);
    var out = [];
    var now = Date.now();
    var vendors = ['acc-2', 'acc-3'];
    var names = { 'acc-2': 'Youssef Ben', 'acc-3': 'Nadia Cherif' };

    for (var back = 30; back >= 0; back--) {
      var dayStart = startOfDay(now - back * DAY);
      var count = 3 + Math.floor(rand() * 7);
      for (var i = 0; i < count; i++) {
        var med = CATALOGUE[Math.floor(rand() * CATALOGUE.length)];
        var vendorId = vendors[Math.floor(rand() * vendors.length)];
        var boxes = 1 + Math.floor(rand() * 3);
        out.push({
          id: 'sale-seed-' + out.length,
          vendorId: vendorId,
          vendorName: names[vendorId],
          medicine: med.name,
          barcode: med.barcode,
          boxes: boxes,
          unitPrice: med.price,
          unitCost: med.cost,
          at: dayStart + Math.floor((9 + rand() * 9) * 3600000),
          source: 'seed'
        });
      }
    }
    return out;
  }

  /* Records written before multi-medicine support carried a single flat
     medication; fold each into a one-item prescription rather than discard
     work already done in the app. */
  function migrateFromV2(old) {
    var byName = {};
    CATALOGUE.forEach(function (m) { byName[m.name] = m; });

    return {
      version: 3,
      seq: old.seq || 480,
      medicines: (old.medicines || []).map(function (m) {
        var ref = byName[m.name];
        return Object.assign({}, m, {
          strength: m.strength || (ref && ref.strength) || '',
          form: m.form && byName[m.name] ? ref.form : (ref ? ref.form : 'comprime'),
          packaging: m.packaging || (ref && ref.packaging) || 'boite',
          barcode: m.barcode || (ref && ref.barcode) || ean13(String(340009900000 + Math.floor(Math.random() * 99999)).slice(0, 12))
        });
      }),
      prescriptions: (old.prescriptions || []).map(function (p) {
        if (p.items) return p;
        var ref = byName[p.medication];
        return {
          code: p.code,
          patient: p.patient,
          prescriber: p.prescriber || 'Dr. E. Okafor',
          items: [{
            medication: p.medication,
            strength: (ref && ref.strength) || '',
            form: (ref && ref.form) || 'comprime',
            packaging: (ref && ref.packaging) || 'boite',
            qty: p.qty,
            route: defaultRoute(ref && ref.form),
            dose: p.dosage || '',
            frequency: '',
            duration: ''
          }],
          status: p.status,
          createdAt: p.createdAt,
          filledAt: p.filledAt,
          source: p.source
        };
      })
    };
  }

  /* Existing installs keep their medicines and prescriptions; accounts and
     sales simply start empty-but-seeded alongside them. */
  function migrateToV4(three) {
    return {
      version: 4,
      seq: three.seq || 480,
      medicines: three.medicines || [],
      prescriptions: three.prescriptions || [],
      accounts: defaultAccounts(Date.now()),
      sales: seedSales(),
      sessionId: null
    };
  }

  function load() {
    if (db) return db;
    try {
      var raw = global.localStorage && global.localStorage.getItem(KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.version === 4 && Array.isArray(parsed.medicines)) {
          db = parsed;
          return db;
        }
      }
      var v3 = global.localStorage && global.localStorage.getItem(LEGACY_V3);
      if (v3) {
        var three = JSON.parse(v3);
        if (three && Array.isArray(three.medicines)) {
          db = migrateToV4(three);
          save();
          return db;
        }
      }
      var legacy = global.localStorage && global.localStorage.getItem(LEGACY_V2);
      if (legacy) {
        var old = JSON.parse(legacy);
        if (old && Array.isArray(old.medicines)) {
          db = migrateToV4(migrateFromV2(old));
          save();
          return db;
        }
      }
    } catch (e) { /* corrupt or unavailable storage — fall through */ }
    db = fresh();
    save();
    return db;
  }

  function save() {
    try {
      if (global.localStorage) global.localStorage.setItem(KEY, JSON.stringify(db));
    } catch (e) { /* private mode or quota — the app still works in memory */ }
  }

  /* ------------------------------------------------------------------ *
   * Medicines
   * ------------------------------------------------------------------ */
  function medicines() { return load().medicines; }

  function findMedicine(name) {
    var target = String(name || '').trim().toLowerCase();
    return load().medicines.find(function (m) {
      return m.name.toLowerCase() === target;
    }) || null;
  }

  function findByBarcode(code) {
    var target = String(code || '').trim();
    return load().medicines.find(function (m) { return m.barcode === target; }) || null;
  }

  function isLow(m) { return m.qty < m.reorder; }
  function lowStockCount() { return medicines().filter(isLow).length; }

  function barcodeOwner(barcode, exceptName) {
    var target = String(barcode || '').trim();
    if (!target) return null;
    return load().medicines.find(function (m) {
      return m.barcode === target && m.name !== exceptName;
    }) || null;
  }

  /* Adding units to a medicine already on the shelf needs nothing but the
     count. Creating one needs its barcode and its pricing — those are facts
     about the product, and inventing them would put wrong numbers into the
     profit figures. */
  function addStock(name, units, details) {
    var d = details || {};
    var existing = findMedicine(name);
    if (existing) {
      existing.qty += units;
      save();
      return { ok: true, medicine: existing, created: false };
    }

    var barcode = String(d.barcode || '').trim();
    if (!barcode) return { ok: false, field: 'barcode', message: 'Barcode is required for a new medicine' };
    if (!/^\d{6,14}$/.test(barcode)) return { ok: false, field: 'barcode', message: 'A barcode is 6 to 14 digits' };
    var clash = barcodeOwner(barcode);
    if (clash) return { ok: false, field: 'barcode', message: 'That barcode already belongs to ' + clash.name };

    var price = Number(d.price), cost = Number(d.cost);
    if (!isFinite(price) || price <= 0) return { ok: false, field: 'price', message: 'Enter a selling price' };
    if (!isFinite(cost) || cost < 0) return { ok: false, field: 'cost', message: 'Enter a cost' };
    if (cost > price) return { ok: false, field: 'cost', message: 'Cost is higher than the selling price' };

    var created = {
      name: String(name).trim(),
      strength: String(d.strength || '').trim(),
      form: d.form || 'comprime',
      packaging: d.packaging || 'boite',
      qty: units,
      reorder: Math.max(10, Math.round(units / 4)),
      batch: 'NEW-' + Math.floor(1000 + Math.random() * 9000),
      expiry: d.expiry || '12/2028',
      price: Math.round(price * 100) / 100,
      cost: Math.round(cost * 100) / 100,
      barcode: barcode
    };
    load().medicines.unshift(created);
    save();
    return { ok: true, medicine: created, created: true };
  }

  /* ------------------------------------------------------------------ *
   * Prescriptions
   * ------------------------------------------------------------------ */
  function prescriptions() { return load().prescriptions; }

  function nextCode() {
    var d = load();
    d.seq += 1;
    save();
    return 'PC-' + new Date().getFullYear() + '-' + String(d.seq).padStart(4, '0');
  }

  function findByCode(code) {
    var target = String(code || '').trim().toUpperCase();
    return prescriptions().find(function (p) {
      return p.code.toUpperCase() === target;
    }) || null;
  }

  function createPrescription(fields) {
    var record = {
      code: fields.code || nextCode(),
      patient: fields.patient,
      prescriber: fields.prescriber || '',
      items: (fields.items || []).map(function (it) {
        return {
          medication: it.medication,
          strength: it.strength || '',
          form: it.form || 'comprime',
          packaging: it.packaging || 'boite',
          qty: Number(it.qty) || 0,
          route: it.route || defaultRoute(it.form),
          dose: it.dose || '',
          frequency: it.frequency || '',
          duration: it.duration || ''
        };
      }),
      status: 'issued',
      createdAt: Date.now(),
      filledAt: null,
      source: fields.source || 'manual'
    };
    load().prescriptions.push(record);
    save();
    return record;
  }

  /* Check every line before moving any stock, so a prescription is either
     dispensed whole or not at all. */
  function checkAvailability(record) {
    var problems = [];
    record.items.forEach(function (item) {
      var med = findMedicine(item.medication);
      if (!med) {
        problems.push({ item: item, reason: 'not-stocked', message: item.medication + ' is not stocked here' });
      } else if (med.qty < item.qty) {
        problems.push({ item: item, reason: 'insufficient', message: 'Only ' + med.qty + ' of ' + med.name + ' left, ' + item.qty + ' needed' });
      }
    });
    return problems;
  }

  function fill(record) {
    var problems = checkAvailability(record);
    if (problems.length) {
      return { ok: false, problems: problems, message: problems[0].message };
    }
    record.items.forEach(function (item) {
      findMedicine(item.medication).qty -= item.qty;
    });
    record.status = 'filled';
    record.filledAt = Date.now();
    save();
    return { ok: true, record: record };
  }

  /* ------------------------------------------------------------------ *
   * Derived figures
   * ------------------------------------------------------------------ */
  function priceOf(name) { var m = findMedicine(name); return m ? m.price : 0; }
  function costOf(name) { var m = findMedicine(name); return m ? m.cost : 0; }

  function summarise(record) {
    if (!record.items.length) return '';
    var first = record.items[0].medication;
    return record.items.length === 1
      ? first
      : first + ' + ' + (record.items.length - 1) + ' more';
  }

  function unitsIn(record) {
    return record.items.reduce(function (n, it) { return n + it.qty; }, 0);
  }

  function filledBetween(from, to) {
    return prescriptions().filter(function (p) {
      return p.status === 'filled' && p.filledAt >= from && p.filledAt < to;
    });
  }

  function totals(records) {
    var revenue = 0, cogs = 0;
    records.forEach(function (p) {
      p.items.forEach(function (it) {
        revenue += priceOf(it.medication) * it.qty;
        cogs += costOf(it.medication) * it.qty;
      });
    });
    return { revenue: revenue, cogs: cogs, profit: revenue - cogs, count: records.length };
  }

  function todaySummary() {
    var from = startOfDay(Date.now());
    var to = from + DAY;
    var filled = filledBetween(from, to);
    var t = totals(filled);
    var yesterday = filledBetween(from - DAY, from).length;
    var issued = prescriptions().filter(function (p) { return p.status === 'issued'; });

    return {
      filled: filled.length,
      filledDelta: filled.length - yesterday,
      revenue: t.revenue,
      lowStock: lowStockCount(),
      awaiting: issued.length,
      oldestAwaiting: issued.reduce(function (oldest, p) {
        return oldest === null || p.createdAt < oldest ? p.createdAt : oldest;
      }, null)
    };
  }

  function recentActivity(limit) {
    return prescriptions().slice().sort(function (a, b) {
      return (b.filledAt || b.createdAt) - (a.filledAt || a.createdAt);
    }).slice(0, limit || 5);
  }

  var PERIODS = {
    daily:   { span: DAY,      buckets: 4, label: 'Last 4 days',   bucketLabel: dayLabel },
    weekly:  { span: DAY * 7,  buckets: 4, label: 'Last 4 weeks',  bucketLabel: weekLabel },
    monthly: { span: DAY * 30, buckets: 4, label: 'Last 4 months', bucketLabel: monthLabel }
  };

  function dayLabel(from) { return new Date(from).toLocaleDateString([], { weekday: 'short' }); }
  function weekLabel(from, index, count) { return 'W' + (count - index); }
  function monthLabel(from) { return new Date(from).toLocaleDateString([], { month: 'short' }); }

  function report(period) {
    var conf = PERIODS[period] || PERIODS.weekly;
    var end = startOfDay(Date.now()) + DAY;
    var from = end - conf.span;

    var current = totals(filledBetween(from, end));
    var previous = totals(filledBetween(from - conf.span, from));
    var change = previous.profit > 0
      ? ((current.profit - previous.profit) / previous.profit) * 100
      : null;

    var bars = [];
    for (var i = conf.buckets - 1; i >= 0; i--) {
      var bFrom = end - conf.span * (i + 1);
      var bTo = end - conf.span * i;
      bars.push({
        label: conf.bucketLabel(bFrom, conf.buckets - 1 - i, conf.buckets),
        value: totals(filledBetween(bFrom, bTo)).revenue
      });
    }

    var byMedicine = {};
    filledBetween(from, end).forEach(function (p) {
      p.items.forEach(function (it) {
        var e = byMedicine[it.medication] || (byMedicine[it.medication] = { revenue: 0, cogs: 0, units: 0 });
        e.revenue += priceOf(it.medication) * it.qty;
        e.cogs += costOf(it.medication) * it.qty;
        e.units += it.qty;
      });
    });

    var items = Object.keys(byMedicine).map(function (name) {
      var e = byMedicine[name];
      return {
        name: name, revenue: e.revenue, units: e.units,
        margin: e.revenue > 0 ? Math.round(((e.revenue - e.cogs) / e.revenue) * 100) : 0,
        profit: e.revenue - e.cogs
      };
    }).sort(function (a, b) { return b.profit - a.profit; }).slice(0, 4);

    return {
      profit: current.profit, revenue: current.revenue, cogs: current.cogs,
      count: current.count,
      cogsShare: current.revenue > 0 ? (current.cogs / current.revenue) * 100 : 0,
      change: change, rangeFrom: from, rangeTo: end,
      chartLabel: conf.label, bars: bars, items: items
    };
  }

  /* ------------------------------------------------------------------ *
   * Accounts, roles and the session
   * ------------------------------------------------------------------ */
  function accounts() { return load().accounts; }

  function vendors() {
    return accounts().filter(function (a) { return a.role === VENDOR; });
  }

  function findAccount(id) {
    return accounts().find(function (a) { return a.id === id; }) || null;
  }

  function currentAccount() {
    var d = load();
    return d.sessionId ? findAccount(d.sessionId) : null;
  }

  function isManager() {
    var a = currentAccount();
    return Boolean(a && a.role === MANAGER);
  }

  function signIn(id, pin) {
    var account = findAccount(id);
    if (!account) return { ok: false, message: 'No such account' };
    if (!account.active) return { ok: false, message: account.name + ' is deactivated' };
    if (String(pin) !== String(account.pin)) return { ok: false, message: 'Incorrect PIN' };
    load().sessionId = account.id;
    save();
    return { ok: true, account: account };
  }

  function signOut() {
    load().sessionId = null;
    save();
  }

  function addVendor(fields) {
    var name = String(fields.name || '').trim();
    if (!name) return { ok: false, message: 'Name is required' };
    if (!/^\d{4}$/.test(String(fields.pin || ''))) {
      return { ok: false, message: 'PIN must be 4 digits' };
    }
    var account = {
      id: 'acc-' + Date.now().toString(36),
      name: name,
      role: VENDOR,
      pin: String(fields.pin),
      active: true,
      createdAt: Date.now()
    };
    load().accounts.push(account);
    save();
    return { ok: true, account: account };
  }

  function updateVendor(id, fields) {
    var account = findAccount(id);
    if (!account || account.role !== VENDOR) return { ok: false, message: 'Not a vendor account' };
    if (fields.name !== undefined) {
      var n = String(fields.name).trim();
      if (!n) return { ok: false, message: 'Name is required' };
      account.name = n;
    }
    if (fields.pin) {
      if (!/^\d{4}$/.test(String(fields.pin))) return { ok: false, message: 'PIN must be 4 digits' };
      account.pin = String(fields.pin);
    }
    if (fields.active !== undefined) account.active = Boolean(fields.active);
    save();
    return { ok: true, account: account };
  }

  /* Vendors are deactivated rather than deleted when they have sales, so the
     figures those sales feed into stay explainable. */
  function removeVendor(id) {
    var account = findAccount(id);
    if (!account || account.role !== VENDOR) return { ok: false, message: 'Not a vendor account' };
    var hasSales = sales().some(function (s) { return s.vendorId === id; });
    if (hasSales) {
      account.active = false;
      save();
      return { ok: true, deactivated: true, account: account };
    }
    var d = load();
    d.accounts = d.accounts.filter(function (a) { return a.id !== id; });
    if (d.sessionId === id) d.sessionId = null;
    save();
    return { ok: true, deactivated: false };
  }

  /* ------------------------------------------------------------------ *
   * Pricing — manager only, enforced by the caller
   * ------------------------------------------------------------------ */
  function setPricing(name, price, cost) {
    var med = findMedicine(name);
    if (!med) return { ok: false, message: 'Not in the catalogue' };
    var p = Number(price), c = Number(cost);
    if (!isFinite(p) || p < 0) return { ok: false, message: 'Enter a valid selling price' };
    if (!isFinite(c) || c < 0) return { ok: false, message: 'Enter a valid cost' };
    if (c > p) return { ok: false, message: 'Cost is higher than the selling price' };
    med.price = Math.round(p * 100) / 100;
    med.cost = Math.round(c * 100) / 100;
    save();
    return { ok: true, medicine: med };
  }

  /* ------------------------------------------------------------------ *
   * Counter sales — a vendor scanning boxes off the shelf
   * ------------------------------------------------------------------ */
  function sales() { return load().sales; }

  function recordSale(vendorId, medicineName, boxes) {
    var vendor = findAccount(vendorId);
    if (!vendor) return { ok: false, message: 'Unknown vendor account' };
    var med = findMedicine(medicineName);
    if (!med) return { ok: false, message: medicineName + ' is not stocked here' };

    var count = Math.max(1, Math.floor(Number(boxes) || 1));
    if (med.qty < count) {
      return { ok: false, message: 'Only ' + med.qty + ' of ' + med.name + ' left' };
    }

    med.qty -= count;
    var sale = {
      id: 'sale-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1000),
      vendorId: vendor.id,
      vendorName: vendor.name,
      medicine: med.name,
      barcode: med.barcode,
      boxes: count,
      // Prices are captured at the moment of sale, so a later price change
      // does not silently rewrite past profit.
      unitPrice: med.price,
      unitCost: med.cost,
      at: Date.now(),
      source: 'scan'
    };
    load().sales.push(sale);
    save();
    return { ok: true, sale: sale, medicine: med };
  }

  function salesBetween(from, to, vendorId) {
    return sales().filter(function (s) {
      if (vendorId && s.vendorId !== vendorId) return false;
      return s.at >= from && s.at < to;
    });
  }

  function saleTotals(list) {
    var revenue = 0, cost = 0, boxes = 0;
    list.forEach(function (s) {
      revenue += s.unitPrice * s.boxes;
      cost += s.unitCost * s.boxes;
      boxes += s.boxes;
    });
    return {
      revenue: revenue, cost: cost, profit: revenue - cost,
      boxes: boxes, count: list.length
    };
  }

  /* Vendor performance over today / last 7 / last 30 days, plus their best
     sellers by profit contribution. */
  function vendorStats(vendorId, period) {
    var spans = { daily: DAY, weekly: DAY * 7, monthly: DAY * 30 };
    var span = spans[period] || spans.daily;
    var end = startOfDay(Date.now()) + DAY;
    var from = end - span;

    var current = saleTotals(salesBetween(from, end, vendorId));
    var previous = saleTotals(salesBetween(from - span, from, vendorId));
    var change = previous.profit > 0
      ? ((current.profit - previous.profit) / previous.profit) * 100
      : null;

    var byMedicine = {};
    salesBetween(from, end, vendorId).forEach(function (s) {
      var e = byMedicine[s.medicine] || (byMedicine[s.medicine] = { boxes: 0, profit: 0, revenue: 0 });
      e.boxes += s.boxes;
      e.revenue += s.unitPrice * s.boxes;
      e.profit += (s.unitPrice - s.unitCost) * s.boxes;
    });
    var top = Object.keys(byMedicine).map(function (name) {
      return {
        name: name, boxes: byMedicine[name].boxes,
        revenue: byMedicine[name].revenue, profit: byMedicine[name].profit
      };
    }).sort(function (a, b) { return b.profit - a.profit; }).slice(0, 5);

    return {
      revenue: current.revenue, cost: current.cost, profit: current.profit,
      boxes: current.boxes, count: current.count,
      change: change, rangeFrom: from, rangeTo: end, top: top
    };
  }

  function recentSales(vendorId, limit) {
    return sales().filter(function (s) { return !vendorId || s.vendorId === vendorId; })
      .slice().sort(function (a, b) { return b.at - a.at; }).slice(0, limit || 8);
  }

  function reset() { db = fresh(); save(); }

  global.PharmaStore = {
    load: load, save: save, reset: reset,
    medicines: medicines, findMedicine: findMedicine, findByBarcode: findByBarcode,
    isLow: isLow, lowStockCount: lowStockCount, addStock: addStock,
    barcodeOwner: barcodeOwner,
    prescriptions: prescriptions, nextCode: nextCode, findByCode: findByCode,
    createPrescription: createPrescription, checkAvailability: checkAvailability, fill: fill,
    summarise: summarise, unitsIn: unitsIn, defaultRoute: defaultRoute,
    todaySummary: todaySummary, recentActivity: recentActivity, report: report,

    // accounts and roles
    MANAGER: MANAGER, VENDOR: VENDOR,
    accounts: accounts, vendors: vendors, findAccount: findAccount,
    currentAccount: currentAccount, isManager: isManager,
    signIn: signIn, signOut: signOut,
    addVendor: addVendor, updateVendor: updateVendor, removeVendor: removeVendor,

    // pricing and counter sales
    setPricing: setPricing,
    sales: sales, recordSale: recordSale, recentSales: recentSales,
    salesBetween: salesBetween, saleTotals: saleTotals, vendorStats: vendorStats
  };
})(typeof self !== 'undefined' ? self : this);
