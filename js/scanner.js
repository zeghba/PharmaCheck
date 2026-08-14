/* =====================================================================
   PharmaCheck — QR scanning

   Pulls frames off the live camera and decodes them for real. Prefers the
   platform's native BarcodeDetector (hardware-accelerated, present in the
   Android WebView and Chrome); falls back to the vendored jsQR decoder
   everywhere else, so desktop Safari and Firefox work too.
   ===================================================================== */
(function (global) {
  'use strict';

  var SCAN_INTERVAL_MS = 180;   // ~5.5 decode attempts a second
  var MAX_EDGE = 800;           // downscale before decoding; 1D barcodes need
                                // more horizontal detail than a QR does

  /* QR carries prescriptions; the 1D formats are what medicine packaging
     actually uses (EAN-13 in Europe, UPC in North America). */
  var FORMATS = ['qr_code', 'ean_13', 'ean_8', 'upc_a', 'upc_e',
                 'code_128', 'code_39', 'itf', 'codabar'];

  function Scanner(video) {
    this.video = video;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.detector = null;
    this.running = false;
    this.timer = null;
    this.onResult = null;
    this.onError = null;

    this.formats = [];
    if (global.BarcodeDetector) {
      try {
        this.detector = new global.BarcodeDetector({ formats: FORMATS });
        this.formats = FORMATS;
      } catch (e) {
        // Some builds reject the whole list if one format is unsupported.
        try {
          this.detector = new global.BarcodeDetector({ formats: ['qr_code'] });
          this.formats = ['qr_code'];
        } catch (e2) {
          this.detector = null;
        }
      }
    }
  }

  /* Narrow the requested formats to what this device actually implements, so
     an unsupported entry cannot make the whole detector unusable. */
  Scanner.prototype.negotiateFormats = function () {
    var self = this;
    if (!global.BarcodeDetector || !global.BarcodeDetector.getSupportedFormats) {
      return Promise.resolve(this.formats);
    }
    return global.BarcodeDetector.getSupportedFormats().then(function (supported) {
      var usable = FORMATS.filter(function (f) { return supported.indexOf(f) !== -1; });
      if (!usable.length) { self.detector = null; self.formats = []; return []; }
      try {
        self.detector = new global.BarcodeDetector({ formats: usable });
        self.formats = usable;
      } catch (e) { /* keep whatever was constructed already */ }
      return self.formats;
    }).catch(function () { return self.formats; });
  };

  /* True when 1D barcodes can be read. jsQR decodes QR only, so a device
     without BarcodeDetector can scan prescriptions but not medicine boxes. */
  Scanner.prototype.canReadBarcodes = function () {
    return this.formats.some(function (f) { return f !== 'qr_code'; });
  };

  Scanner.prototype.engine = function () {
    if (this.detector) return 'native';
    if (global.jsQR) return 'jsQR';
    return 'none';
  };

  Scanner.prototype.start = function (onResult, onError) {
    this.onResult = onResult;
    this.onError = onError;
    if (this.running) return;
    this.running = true;
    this.tick();
  };

  Scanner.prototype.stop = function () {
    this.running = false;
    clearTimeout(this.timer);
  };

  Scanner.prototype.tick = function () {
    var self = this;
    if (!this.running) return;

    this.scanOnce().then(function (hit) {
      if (!self.running) return;
      if (hit && self.onResult) {
        self.onResult(hit);
        return; // caller decides whether to resume
      }
      self.timer = setTimeout(function () { self.tick(); }, SCAN_INTERVAL_MS);
    }).catch(function (err) {
      if (!self.running) return;
      if (self.onError) self.onError(err);
      self.timer = setTimeout(function () { self.tick(); }, SCAN_INTERVAL_MS * 3);
    });
  };

  /* Grab the current frame and try to decode it. Resolves with the decoded
     string, or null when the frame holds no readable code. */
  Scanner.prototype.scanOnce = function () {
    var video = this.video;
    if (!video || video.readyState < 2 || !video.videoWidth) {
      return Promise.resolve(null);
    }

    var scale = Math.min(1, MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
    var w = Math.round(video.videoWidth * scale);
    var h = Math.round(video.videoHeight * scale);

    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.drawImage(video, 0, 0, w, h);

    if (this.detector) {
      return this.detector.detect(this.canvas).then(function (codes) {
        if (!codes || !codes.length) return null;
        // Prefer a QR when several codes are in frame: a prescription is a
        // more specific intent than a product barcode.
        var qr = codes.find(function (c) { return c.format === 'qr_code'; });
        var hit = qr || codes[0];
        return { text: hit.rawValue, format: hit.format };
      });
    }

    if (global.jsQR) {
      var image = this.ctx.getImageData(0, 0, w, h);
      // attemptBoth handles codes printed light-on-dark as well as the usual way.
      var found = global.jsQR(image.data, w, h, { inversionAttempts: 'attemptBoth' });
      return Promise.resolve(found ? { text: found.data, format: 'qr_code' } : null);
    }

    return Promise.reject(new Error('No QR decoding support in this browser'));
  };

  /* ------------------------------------------------------------------ *
   * Payload parsing
   *
   * PharmaCheck codes are `PC1|code|patient|medication|dosage|qty`. Anything
   * else still decodes — it is surfaced as raw text rather than silently
   * ignored, so an unrecognised code looks like an unrecognised code.
   * ------------------------------------------------------------------ */
  /* PharmaCheck prescription payload, version 2:
   *
   *   PC2|code|patient|prescriber|med~strength~form~pack~qty~route~dose~freq~dur|…
   *
   * Version 1 (single medicine, `PC1|code|patient|med|dosage|qty`) is still
   * accepted so codes printed before multi-medicine support keep scanning.
   */
  function parseItems(fields) {
    return fields.map(function (chunk) {
      var f = chunk.split('~');
      return {
        medication: f[0] || '', strength: f[1] || '', form: f[2] || 'comprime',
        packaging: f[3] || 'boite', qty: parseInt(f[4], 10) || 0,
        route: f[5] || 'orale', dose: f[6] || '', frequency: f[7] || '', duration: f[8] || ''
      };
    }).filter(function (it) { return it.medication; });
  }

  function parse(hit) {
    var text = hit && hit.text !== undefined ? hit.text : hit;
    var format = (hit && hit.format) || 'qr_code';
    var raw = String(text == null ? '' : text).trim();
    if (!raw) return { kind: 'empty', raw: raw, format: format };

    var parts = raw.split('|');

    if (parts[0] === 'PC2' && parts.length >= 5) {
      return {
        kind: 'prescription', raw: raw, format: format, code: parts[1],
        patient: parts[2], prescriber: parts[3], items: parseItems(parts.slice(4))
      };
    }

    if (parts[0] === 'PC1' && parts.length >= 6) {
      var qty = parseInt(parts[5], 10);
      return {
        kind: 'prescription', raw: raw, format: format, code: parts[1],
        patient: parts[2], prescriber: '',
        items: [{
          medication: parts[3], strength: '', form: 'comprime', packaging: 'boite',
          qty: isNaN(qty) ? 0 : qty, route: 'orale', dose: parts[4],
          frequency: '', duration: ''
        }]
      };
    }

    if (/^PC-[A-Z0-9]+-\d+$/i.test(raw)) {
      return { kind: 'code', raw: raw, format: format, code: raw.toUpperCase() };
    }

    // A product barcode off a medicine box.
    if (format !== 'qr_code' && /^\d{6,14}$/.test(raw)) {
      return { kind: 'barcode', raw: raw, format: format, barcode: raw };
    }

    return { kind: 'unknown', raw: raw, format: format };
  }

  global.PharmaScanner = { Scanner: Scanner, parse: parse };
})(typeof self !== 'undefined' ? self : this);
