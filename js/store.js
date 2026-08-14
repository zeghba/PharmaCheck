/* =====================================================================
   PharmaCheck — data layer

   One source of truth for medicines and prescriptions, persisted to
   localStorage. Every figure the dashboard and the reports screen show is
   derived from these records; nothing on screen is a hard-coded number.
   ===================================================================== */
(function (global) {
  'use strict';

  var KEY = 'pharmacheck.db.v2';
  var DAY = 86400000;

  /* Catalogue seed. `price` is what the patient pays per unit, `cost` what
     the pharmacy paid, which is what makes margin reporting possible. */
  var CATALOGUE = [
    { name: 'Amoxicillin 500mg',  form: 'Capsules', qty: 34,  reorder: 40,  batch: 'AMX-2291', expiry: '03/2027', price: 0.85,  cost: 0.48 },
    { name: 'Atorvastatin 20mg',  form: 'Tablets',  qty: 264, reorder: 60,  batch: 'ATV-1180', expiry: '11/2027', price: 1.20,  cost: 0.62 },
    { name: 'Metformin 850mg',    form: 'Tablets',  qty: 412, reorder: 100, batch: 'MET-3320', expiry: '06/2028', price: 0.55,  cost: 0.31 },
    { name: 'Salbutamol Inhaler', form: 'Inhaler',  qty: 7,   reorder: 25,  batch: 'SAL-0442', expiry: '01/2027', price: 18.50, cost: 11.40 },
    { name: 'Omeprazole 20mg',    form: 'Capsules', qty: 156, reorder: 50,  batch: 'OMP-7715', expiry: '09/2026', price: 0.95,  cost: 0.58 },
    { name: 'Lisinopril 10mg',    form: 'Tablets',  qty: 92,  reorder: 60,  batch: 'LIS-2043', expiry: '04/2028', price: 0.70,  cost: 0.42 },
    { name: 'Ibuprofen 400mg',    form: 'Tablets',  qty: 31,  reorder: 80,  batch: 'IBU-9931', expiry: '12/2026', price: 0.35,  cost: 0.18 },
    { name: 'Cetirizine 10mg',    form: 'Tablets',  qty: 208, reorder: 45,  batch: 'CET-5507', expiry: '08/2028', price: 0.45,  cost: 0.29 },
    { name: 'Insulin Glargine',   form: 'Pens',     qty: 12,  reorder: 20,  batch: 'INS-8812', expiry: '02/2027', price: 42.00, cost: 27.50 },
    { name: 'Paracetamol 500mg',  form: 'Tablets',  qty: 640, reorder: 150, batch: 'PAR-1002', expiry: '10/2028', price: 0.22,  cost: 0.11 },
    { name: 'Azithromycin 250mg', form: 'Tablets',  qty: 44,  reorder: 40,  batch: 'AZI-6634', expiry: '05/2027', price: 2.40,  cost: 1.45 },
    { name: 'Warfarin 5mg',       form: 'Tablets',  qty: 9,   reorder: 30,  batch: 'WAR-4419', expiry: '07/2026', price: 0.80,  cost: 0.46 }
  ];

  var PATIENTS = [
    'Maria Gonzalez', 'J. Whitfield', 'A. Rahman', 'Chen Wei', 'Fatima Noor',
    'Peter Lindqvist', 'Grace Adeyemi', 'Tomas Novak', 'Aisha Khan', 'Liam O\'Connor',
    'Sofia Rossi', 'Daniel Mbeki'
  ];

  var DOSAGES = ['1 tablet daily', '1 capsule, 3× daily', '2 tablets twice daily',
                 '1 tablet nightly', '1 capsule twice daily', 'As needed'];

  /* Deterministic PRNG so the seeded trading history is identical on every
     device and never shifts between reloads. */
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

  /* Four months of trading history, so the reports screen has something real
     to aggregate on a fresh install. Marked `seed` so it is distinguishable
     from prescriptions actually handled in the app. */
  function seedHistory() {
    var rand = lcg(20260814);
    var out = [];
    var now = Date.now();
    var counter = 1;

    for (var back = 124; back >= 1; back--) {
      var dayStart = startOfDay(now - back * DAY);
      var weekday = new Date(dayStart).getDay();
      // Quieter at weekends, which makes the weekly trend look like a pharmacy.
      var volume = (weekday === 0 ? 6 : weekday === 6 ? 14 : 22) + Math.floor(rand() * 12);

      for (var i = 0; i < volume; i++) {
        var med = CATALOGUE[Math.floor(rand() * CATALOGUE.length)];
        var units = med.price > 10
          ? 1 + Math.floor(rand() * 2)
          : 14 + Math.floor(rand() * 46);
        var at = dayStart + Math.floor((8 + rand() * 10) * 3600000);
        out.push({
          code: 'PC-SEED-' + String(counter++).padStart(5, '0'),
          patient: PATIENTS[Math.floor(rand() * PATIENTS.length)],
          medication: med.name,
          dosage: DOSAGES[Math.floor(rand() * DOSAGES.length)],
          qty: units,
          status: 'filled',
          createdAt: at,
          filledAt: at,
          source: 'seed'
        });
      }
    }

    // A few still awaiting verification, so that metric is real too.
    for (var p = 0; p < 3; p++) {
      var m = CATALOGUE[Math.floor(rand() * CATALOGUE.length)];
      out.push({
        code: 'PC-SEED-' + String(counter++).padStart(5, '0'),
        patient: PATIENTS[Math.floor(rand() * PATIENTS.length)],
        medication: m.name,
        dosage: DOSAGES[Math.floor(rand() * DOSAGES.length)],
        qty: 20 + Math.floor(rand() * 20),
        status: 'issued',
        createdAt: now - Math.floor((12 + p * 40) * 60000),
        filledAt: null,
        source: 'seed'
      });
    }

    return out;
  }

  function fresh() {
    return {
      version: 2,
      seq: 480,
      medicines: CATALOGUE.map(function (m) { return Object.assign({}, m); }),
      prescriptions: seedHistory()
    };
  }

  function load() {
    if (db) return db;
    try {
      var raw = global.localStorage && global.localStorage.getItem(KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.version === 2 && Array.isArray(parsed.medicines)) {
          db = parsed;
          return db;
        }
      }
    } catch (e) { /* corrupt or unavailable storage — fall through to a fresh db */ }
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

  function isLow(m) { return m.qty < m.reorder; }

  function lowStockCount() { return medicines().filter(isLow).length; }

  function addStock(name, units) {
    var existing = findMedicine(name);
    if (existing) {
      existing.qty += units;
    } else {
      existing = {
        name: String(name).trim(), form: 'Units', qty: units,
        reorder: Math.max(10, Math.round(units / 4)),
        batch: 'NEW-' + Math.floor(1000 + Math.random() * 9000),
        expiry: '12/2028', price: 1.00, cost: 0.60
      };
      load().medicines.unshift(existing);
    }
    save();
    return existing;
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
      medication: fields.medication,
      dosage: fields.dosage,
      qty: Number(fields.qty),
      status: 'issued',
      createdAt: Date.now(),
      filledAt: null,
      source: fields.source || 'manual'
    };
    load().prescriptions.push(record);
    save();
    return record;
  }

  /* Dispensing is the only path that moves stock. Refuses rather than going
     negative — a pharmacy cannot hand over what it does not have. */
  function fill(record) {
    var med = findMedicine(record.medication);
    if (!med) {
      return { ok: false, reason: 'not-stocked', message: record.medication + ' is not in this pharmacy’s inventory' };
    }
    if (med.qty < record.qty) {
      return { ok: false, reason: 'insufficient', message: 'Only ' + med.qty + ' units of ' + med.name + ' in stock — ' + record.qty + ' needed' };
    }
    med.qty -= record.qty;
    record.status = 'filled';
    record.filledAt = Date.now();
    save();
    return { ok: true, medicine: med, record: record };
  }

  /* ------------------------------------------------------------------ *
   * Derived figures
   * ------------------------------------------------------------------ */
  function priceOf(name) {
    var m = findMedicine(name);
    return m ? m.price : 0;
  }
  function costOf(name) {
    var m = findMedicine(name);
    return m ? m.cost : 0;
  }

  function filledBetween(from, to) {
    return prescriptions().filter(function (p) {
      return p.status === 'filled' && p.filledAt >= from && p.filledAt < to;
    });
  }

  function totals(records) {
    var revenue = 0, cogs = 0;
    records.forEach(function (p) {
      revenue += priceOf(p.medication) * p.qty;
      cogs += costOf(p.medication) * p.qty;
    });
    return { revenue: revenue, cogs: cogs, profit: revenue - cogs, count: records.length };
  }

  function todaySummary() {
    var from = startOfDay(Date.now());
    var to = from + DAY;
    var filled = filledBetween(from, to);
    var t = totals(filled);
    var yesterday = filledBetween(from - DAY, from).length;

    return {
      filled: filled.length,
      filledDelta: filled.length - yesterday,
      revenue: t.revenue,
      lowStock: lowStockCount(),
      awaiting: prescriptions().filter(function (p) { return p.status === 'issued'; }).length,
      oldestAwaiting: prescriptions()
        .filter(function (p) { return p.status === 'issued'; })
        .reduce(function (oldest, p) {
          return oldest === null || p.createdAt < oldest ? p.createdAt : oldest;
        }, null)
    };
  }

  function recentActivity(limit) {
    return prescriptions()
      .slice()
      .sort(function (a, b) {
        return (b.filledAt || b.createdAt) - (a.filledAt || a.createdAt);
      })
      .slice(0, limit || 5);
  }

  /* Period reporting. Buckets are the last four days / weeks / months so the
     trend chart and the headline figure describe the same window. */
  var PERIODS = {
    daily:   { span: DAY,      buckets: 4, label: 'Last 4 days',   bucketLabel: dayLabel },
    weekly:  { span: DAY * 7,  buckets: 4, label: 'Last 4 weeks',  bucketLabel: weekLabel },
    monthly: { span: DAY * 30, buckets: 4, label: 'Last 4 months', bucketLabel: monthLabel }
  };

  function dayLabel(from) {
    return new Date(from).toLocaleDateString([], { weekday: 'short' });
  }
  function weekLabel(from, index, count) {
    return 'W' + (count - index);
  }
  function monthLabel(from) {
    return new Date(from).toLocaleDateString([], { month: 'short' });
  }

  function report(period) {
    var conf = PERIODS[period] || PERIODS.weekly;
    var now = Date.now();
    var end = startOfDay(now) + DAY;
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

    // Group the period's sales by medicine to rank by contribution.
    var byMedicine = {};
    filledBetween(from, end).forEach(function (p) {
      var entry = byMedicine[p.medication] || (byMedicine[p.medication] = { revenue: 0, cogs: 0, units: 0 });
      entry.revenue += priceOf(p.medication) * p.qty;
      entry.cogs += costOf(p.medication) * p.qty;
      entry.units += p.qty;
    });

    var items = Object.keys(byMedicine).map(function (name) {
      var e = byMedicine[name];
      return {
        name: name,
        revenue: e.revenue,
        units: e.units,
        margin: e.revenue > 0 ? Math.round(((e.revenue - e.cogs) / e.revenue) * 100) : 0,
        profit: e.revenue - e.cogs
      };
    }).sort(function (a, b) { return b.profit - a.profit; }).slice(0, 4);

    return {
      profit: current.profit,
      revenue: current.revenue,
      cogs: current.cogs,
      count: current.count,
      cogsShare: current.revenue > 0 ? (current.cogs / current.revenue) * 100 : 0,
      change: change,
      rangeFrom: from,
      rangeTo: end,
      chartLabel: conf.label,
      bars: bars,
      items: items
    };
  }

  function reset() {
    db = fresh();
    save();
  }

  global.PharmaStore = {
    load: load,
    save: save,
    reset: reset,
    medicines: medicines,
    findMedicine: findMedicine,
    isLow: isLow,
    lowStockCount: lowStockCount,
    addStock: addStock,
    prescriptions: prescriptions,
    nextCode: nextCode,
    findByCode: findByCode,
    createPrescription: createPrescription,
    fill: fill,
    todaySummary: todaySummary,
    recentActivity: recentActivity,
    report: report
  };
})(typeof self !== 'undefined' ? self : this);
