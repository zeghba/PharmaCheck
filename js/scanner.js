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
  var MAX_EDGE = 640;           // downscale before decoding; plenty for a QR

  function Scanner(video) {
    this.video = video;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.detector = null;
    this.running = false;
    this.timer = null;
    this.onResult = null;
    this.onError = null;

    if (global.BarcodeDetector) {
      try {
        this.detector = new global.BarcodeDetector({ formats: ['qr_code'] });
      } catch (e) {
        this.detector = null; // constructed but unsupported format
      }
    }
  }

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

    this.scanOnce().then(function (text) {
      if (!self.running) return;
      if (text && self.onResult) {
        self.onResult(text);
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
        return codes && codes.length ? codes[0].rawValue : null;
      });
    }

    if (global.jsQR) {
      var image = this.ctx.getImageData(0, 0, w, h);
      // attemptBoth handles codes printed light-on-dark as well as the usual way.
      var found = global.jsQR(image.data, w, h, { inversionAttempts: 'attemptBoth' });
      return Promise.resolve(found ? found.data : null);
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
  function parse(text) {
    var raw = String(text == null ? '' : text).trim();
    if (!raw) return { kind: 'empty', raw: raw };

    var parts = raw.split('|');
    if (parts[0] === 'PC1' && parts.length >= 6) {
      var qty = parseInt(parts[5], 10);
      return {
        kind: 'prescription',
        raw: raw,
        code: parts[1],
        patient: parts[2],
        medication: parts[3],
        dosage: parts[4],
        qty: isNaN(qty) ? 0 : qty
      };
    }

    // A bare PharmaCheck code, e.g. re-scanning a printed slip.
    if (/^PC-[A-Z0-9]+-\d+$/i.test(raw)) {
      return { kind: 'code', raw: raw, code: raw.toUpperCase() };
    }

    return { kind: 'unknown', raw: raw };
  }

  global.PharmaScanner = { Scanner: Scanner, parse: parse };
})(typeof self !== 'undefined' ? self : this);
