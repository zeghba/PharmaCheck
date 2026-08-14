/*
 * qr.js — minimal QR Code (Model 2) encoder.
 *
 * Byte mode, error correction level M, versions 1-10 (up to 211 characters).
 * Produces a boolean module matrix that PharmaCheck renders as an SVG.
 *
 * Written from the ISO/IEC 18004 spec: GF(256) Reed-Solomon, block
 * interleaving, the eight mask patterns and the four penalty rules.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QRCodeGen = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Version / error-correction tables (level M only)
   * [ecCodewordsPerBlock, blocksInGroup1, dataPerBlock1, blocksInGroup2, dataPerBlock2]
   * ------------------------------------------------------------------ */
  var EC_TABLE_M = {
    1: [10, 1, 16, 0, 0],
    2: [16, 1, 28, 0, 0],
    3: [26, 1, 44, 0, 0],
    4: [18, 2, 32, 0, 0],
    5: [24, 2, 43, 0, 0],
    6: [16, 4, 27, 0, 0],
    7: [18, 4, 31, 0, 0],
    8: [22, 2, 38, 2, 39],
    9: [22, 3, 36, 2, 37],
    10: [26, 4, 43, 1, 44]
  };

  var ALIGNMENT = {
    1: [],
    2: [6, 18],
    3: [6, 22],
    4: [6, 26],
    5: [6, 30],
    6: [6, 34],
    7: [6, 22, 38],
    8: [6, 24, 42],
    9: [6, 26, 46],
    10: [6, 28, 50]
  };

  var MAX_VERSION = 10;

  function dataCodewords(version) {
    var t = EC_TABLE_M[version];
    return t[1] * t[2] + t[3] * t[4];
  }

  /* Characters that fit in byte mode for a given version. The header is a
   * 4-bit mode indicator plus an 8-bit length (16-bit from version 10). */
  function byteCapacity(version) {
    var headerBits = 4 + (version < 10 ? 8 : 16);
    return dataCodewords(version) - Math.ceil(headerBits / 8);
  }

  /* ------------------------------------------------------------------ *
   * GF(256) arithmetic, primitive polynomial 0x11D
   * ------------------------------------------------------------------ */
  var EXP = new Uint8Array(512);
  var LOG = new Uint8Array(256);
  (function initGaloisField() {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  /* Generator polynomial for `degree` error-correction codewords. */
  function generatorPoly(degree) {
    var poly = [1];
    for (var d = 0; d < degree; d++) {
      var next = new Array(poly.length + 1).fill(0);
      for (var i = 0; i < poly.length; i++) {
        next[i] ^= poly[i];
        next[i + 1] ^= gfMul(poly[i], EXP[d]);
      }
      poly = next;
    }
    return poly;
  }

  function eccForBlock(block, ecLength) {
    var gen = generatorPoly(ecLength);
    var remainder = new Array(ecLength).fill(0);
    for (var i = 0; i < block.length; i++) {
      var factor = block[i] ^ remainder[0];
      remainder.shift();
      remainder.push(0);
      for (var j = 0; j < ecLength; j++) {
        remainder[j] ^= gfMul(gen[j + 1], factor);
      }
    }
    return remainder;
  }

  /* ------------------------------------------------------------------ *
   * BCH codes for the format and version information areas
   * ------------------------------------------------------------------ */
  function bch(value, generator, generatorBits) {
    var shifted = value << (generatorBits - 1);
    var remainder = shifted;
    while (bitLength(remainder) >= generatorBits) {
      remainder ^= generator << (bitLength(remainder) - generatorBits);
    }
    return shifted | remainder;
  }

  function bitLength(v) {
    var n = 0;
    while (v) {
      n++;
      v >>>= 1;
    }
    return n;
  }

  /* Level M is encoded as 00 in the format string. */
  function formatBits(mask) {
    var data = (0x00 << 3) | mask;
    return (bch(data, 0x537, 11) ^ 0x5412) & 0x7fff;
  }

  function versionBits(version) {
    return bch(version, 0x1f25, 13) & 0x3ffff;
  }

  /* ------------------------------------------------------------------ *
   * Bit buffer
   * ------------------------------------------------------------------ */
  function BitBuffer() {
    this.bits = [];
  }
  BitBuffer.prototype.put = function (value, length) {
    for (var i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  };

  function toUtf8Bytes(text) {
    var out = [];
    var encoded = encodeURIComponent(text);
    for (var i = 0; i < encoded.length; i++) {
      if (encoded[i] === '%') {
        out.push(parseInt(encoded.substr(i + 1, 2), 16));
        i += 2;
      } else {
        out.push(encoded.charCodeAt(i));
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Encoding
   * ------------------------------------------------------------------ */
  function encodeData(bytes, version) {
    var buffer = new BitBuffer();
    buffer.put(0x4, 4); // byte mode
    buffer.put(bytes.length, version < 10 ? 8 : 16);
    for (var i = 0; i < bytes.length; i++) buffer.put(bytes[i], 8);

    var capacityBits = dataCodewords(version) * 8;
    var terminator = Math.min(4, capacityBits - buffer.bits.length);
    buffer.put(0, terminator);
    while (buffer.bits.length % 8 !== 0) buffer.bits.push(0);

    var codewords = [];
    for (var b = 0; b < buffer.bits.length; b += 8) {
      var byte = 0;
      for (var k = 0; k < 8; k++) byte = (byte << 1) | buffer.bits[b + k];
      codewords.push(byte);
    }
    var pad = [0xec, 0x11];
    var p = 0;
    while (codewords.length < dataCodewords(version)) {
      codewords.push(pad[p++ % 2]);
    }
    return codewords;
  }

  function interleave(codewords, version) {
    var t = EC_TABLE_M[version];
    var ecLength = t[0];
    var blocks = [];
    var offset = 0;
    var g;

    for (g = 0; g < t[1]; g++) {
      blocks.push(codewords.slice(offset, offset + t[2]));
      offset += t[2];
    }
    for (g = 0; g < t[3]; g++) {
      blocks.push(codewords.slice(offset, offset + t[4]));
      offset += t[4];
    }

    var eccBlocks = blocks.map(function (block) {
      return eccForBlock(block, ecLength);
    });

    var result = [];
    var maxData = Math.max(t[2], t[4]);
    var i, j;
    for (i = 0; i < maxData; i++) {
      for (j = 0; j < blocks.length; j++) {
        if (i < blocks[j].length) result.push(blocks[j][i]);
      }
    }
    for (i = 0; i < ecLength; i++) {
      for (j = 0; j < eccBlocks.length; j++) result.push(eccBlocks[j][i]);
    }
    return result;
  }

  /* ------------------------------------------------------------------ *
   * Matrix construction
   * ------------------------------------------------------------------ */
  function createMatrix(size) {
    var m = [];
    for (var r = 0; r < size; r++) m.push(new Array(size).fill(null));
    return m;
  }

  function placeFinder(matrix, row, col) {
    for (var r = -1; r <= 7; r++) {
      for (var c = -1; c <= 7; c++) {
        var rr = row + r;
        var cc = col + c;
        if (rr < 0 || cc < 0 || rr >= matrix.length || cc >= matrix.length) continue;
        var inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                     (c >= 0 && c <= 6 && (r === 0 || r === 6));
        var inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        matrix[rr][cc] = inRing || inCore;
      }
    }
  }

  function placeFunctionPatterns(matrix, version) {
    var size = matrix.length;
    var i;

    placeFinder(matrix, 0, 0);
    placeFinder(matrix, 0, size - 7);
    placeFinder(matrix, size - 7, 0);

    // Timing patterns
    for (i = 8; i < size - 8; i++) {
      var on = i % 2 === 0;
      if (matrix[6][i] === null) matrix[6][i] = on;
      if (matrix[i][6] === null) matrix[i][6] = on;
    }

    // Alignment patterns. Every combination of centre coordinates is used
    // except the three that would land on a finder pattern; the ones that
    // straddle a timing line legitimately overwrite it.
    var positions = ALIGNMENT[version];
    var last = positions.length - 1;
    for (var a = 0; a < positions.length; a++) {
      for (var b = 0; b < positions.length; b++) {
        var onFinder = (a === 0 && b === 0) ||
                       (a === 0 && b === last) ||
                       (a === last && b === 0);
        if (onFinder) continue;
        var cr = positions[a];
        var cc = positions[b];
        for (var dr = -2; dr <= 2; dr++) {
          for (var dc = -2; dc <= 2; dc++) {
            var ring = Math.max(Math.abs(dr), Math.abs(dc));
            matrix[cr + dr][cc + dc] = ring !== 1;
          }
        }
      }
    }

    // Dark module
    matrix[size - 8][8] = true;

    // Reserve the format areas so data placement skips them
    for (i = 0; i <= 8; i++) {
      if (matrix[8][i] === null) matrix[8][i] = false;
      if (matrix[i][8] === null) matrix[i][8] = false;
    }
    for (i = 0; i < 8; i++) {
      if (matrix[8][size - 1 - i] === null) matrix[8][size - 1 - i] = false;
      if (matrix[size - 1 - i][8] === null) matrix[size - 1 - i][8] = false;
    }

    // Reserve the version areas (version 7 and up)
    if (version >= 7) {
      for (i = 0; i < 6; i++) {
        for (var k = 0; k < 3; k++) {
          matrix[size - 11 + k][i] = false;
          matrix[i][size - 11 + k] = false;
        }
      }
    }
  }

  function placeData(matrix, reserved, bytes) {
    var size = matrix.length;
    var bitIndex = 0;
    var totalBits = bytes.length * 8;
    var upward = true;

    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right--; // skip the vertical timing column
      for (var step = 0; step < size; step++) {
        var row = upward ? size - 1 - step : step;
        for (var c = 0; c < 2; c++) {
          var col = right - c;
          if (reserved[row][col]) continue;
          var bit = false;
          if (bitIndex < totalBits) {
            bit = ((bytes[bitIndex >> 3] >>> (7 - (bitIndex & 7))) & 1) === 1;
            bitIndex++;
          }
          matrix[row][col] = bit;
        }
      }
      upward = !upward;
    }
  }

  function maskCondition(mask, row, col) {
    switch (mask) {
      case 0: return (row + col) % 2 === 0;
      case 1: return row % 2 === 0;
      case 2: return col % 3 === 0;
      case 3: return (row + col) % 3 === 0;
      case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
      case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
      case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
      case 7: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
      default: return false;
    }
  }

  function applyMask(matrix, reserved, mask) {
    for (var r = 0; r < matrix.length; r++) {
      for (var c = 0; c < matrix.length; c++) {
        if (reserved[r][c]) continue;
        if (maskCondition(mask, r, c)) matrix[r][c] = !matrix[r][c];
      }
    }
  }

  function placeFormatInfo(matrix, mask) {
    var size = matrix.length;
    var bits = formatBits(mask);
    var i;

    // First copy: down the left of the top-left finder, then along the top.
    for (i = 0; i <= 5; i++) matrix[i][8] = ((bits >> i) & 1) === 1;
    matrix[7][8] = ((bits >> 6) & 1) === 1;
    matrix[8][8] = ((bits >> 7) & 1) === 1;
    matrix[8][7] = ((bits >> 8) & 1) === 1;
    for (i = 9; i <= 14; i++) matrix[8][14 - i] = ((bits >> i) & 1) === 1;

    // Second copy: along the bottom-left, then the top-right.
    for (i = 0; i <= 7; i++) matrix[8][size - 1 - i] = ((bits >> i) & 1) === 1;
    for (i = 8; i <= 14; i++) matrix[size - 15 + i][8] = ((bits >> i) & 1) === 1;
    matrix[size - 8][8] = true;
  }

  function placeVersionInfo(matrix, version) {
    if (version < 7) return;
    var size = matrix.length;
    var bits = versionBits(version);
    for (var i = 0; i < 18; i++) {
      var bit = ((bits >> i) & 1) === 1;
      var row = Math.floor(i / 3);
      var col = size - 11 + (i % 3);
      matrix[row][col] = bit;
      matrix[col][row] = bit;
    }
  }

  /* ------------------------------------------------------------------ *
   * Mask penalty scoring (ISO/IEC 18004 rules 1-4)
   * ------------------------------------------------------------------ */
  function penalty(matrix) {
    var size = matrix.length;
    var score = 0;
    var r, c, run, dark = 0;

    // Rule 1 — runs of five or more same-coloured modules
    for (r = 0; r < size; r++) {
      run = 1;
      for (c = 1; c < size; c++) {
        if (matrix[r][c] === matrix[r][c - 1]) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else run = 1;
      }
    }
    for (c = 0; c < size; c++) {
      run = 1;
      for (r = 1; r < size; r++) {
        if (matrix[r][c] === matrix[r - 1][c]) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else run = 1;
      }
    }

    // Rule 2 — 2x2 blocks of one colour
    for (r = 0; r < size - 1; r++) {
      for (c = 0; c < size - 1; c++) {
        var v = matrix[r][c];
        if (v === matrix[r][c + 1] && v === matrix[r + 1][c] && v === matrix[r + 1][c + 1]) {
          score += 3;
        }
      }
    }

    // Rule 3 — finder-like patterns
    var patternA = [true, false, true, true, true, false, true, false, false, false, false];
    var patternB = [false, false, false, false, true, false, true, true, true, false, true];
    function matches(get, start, pattern) {
      for (var i = 0; i < pattern.length; i++) {
        if (get(start + i) !== pattern[i]) return false;
      }
      return true;
    }
    for (r = 0; r < size; r++) {
      for (c = 0; c <= size - 11; c++) {
        var rowGet = (function (row) {
          return function (idx) { return matrix[row][idx]; };
        })(r);
        if (matches(rowGet, c, patternA) || matches(rowGet, c, patternB)) score += 40;
      }
    }
    for (c = 0; c < size; c++) {
      for (r = 0; r <= size - 11; r++) {
        var colGet = (function (col) {
          return function (idx) { return matrix[idx][col]; };
        })(c);
        if (matches(colGet, r, patternA) || matches(colGet, r, patternB)) score += 40;
      }
    }

    // Rule 4 — balance of dark and light modules
    for (r = 0; r < size; r++) {
      for (c = 0; c < size; c++) if (matrix[r][c]) dark++;
    }
    var percent = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(percent - 50) / 5) * 10;

    return score;
  }

  function cloneMatrix(matrix) {
    return matrix.map(function (row) { return row.slice(); });
  }

  /* ------------------------------------------------------------------ *
   * Public API
   * ------------------------------------------------------------------ */
  function generate(text) {
    var bytes = toUtf8Bytes(String(text));
    var version = 0;
    for (var v = 1; v <= MAX_VERSION; v++) {
      if (bytes.length <= byteCapacity(v)) {
        version = v;
        break;
      }
    }
    if (!version) {
      throw new Error('Payload too long for QR versions 1-' + MAX_VERSION +
        ' (max ' + byteCapacity(MAX_VERSION) + ' bytes, got ' + bytes.length + ').');
    }

    var size = version * 4 + 17;
    var codewords = interleave(encodeData(bytes, version), version);

    var base = createMatrix(size);
    placeFunctionPatterns(base, version);
    var reserved = base.map(function (row) {
      return row.map(function (cell) { return cell !== null; });
    });
    placeData(base, reserved, codewords);

    var best = null;
    var bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      var candidate = cloneMatrix(base);
      applyMask(candidate, reserved, mask);
      placeFormatInfo(candidate, mask);
      placeVersionInfo(candidate, version);
      var score = penalty(candidate);
      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    return { version: version, size: size, modules: best };
  }

  /* Render a QR matrix as a standalone SVG string. */
  function toSvg(text, options) {
    var opts = options || {};
    var quiet = opts.quietZone == null ? 3 : opts.quietZone;
    var dark = opts.dark || '#0F1B2D';
    var light = opts.light || '#FFFFFF';
    var qr = generate(text);
    var dim = qr.size + quiet * 2;
    var path = [];

    for (var r = 0; r < qr.size; r++) {
      for (var c = 0; c < qr.size; c++) {
        if (qr.modules[r][c]) {
          path.push('M' + (c + quiet) + ' ' + (r + quiet) + 'h1v1h-1z');
        }
      }
    }

    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim +
      '" shape-rendering="crispEdges" role="img" aria-label="QR code">' +
      '<rect width="' + dim + '" height="' + dim + '" fill="' + light + '"/>' +
      '<path d="' + path.join('') + '" fill="' + dark + '"/></svg>';
  }

  /* Exposed so test/verify-qr.js can diff intermediate stages against a
   * reference encoder. Not used by the app itself. */
  function _stages(text) {
    var bytes = toUtf8Bytes(String(text));
    var version = 1;
    while (version <= MAX_VERSION && bytes.length > byteCapacity(version)) version++;
    var data = encodeData(bytes, version);
    var stream = interleave(data, version);

    var size = version * 4 + 17;
    var base = createMatrix(size);
    placeFunctionPatterns(base, version);
    var reserved = base.map(function (row) {
      return row.map(function (cell) { return cell !== null; });
    });
    placeData(base, reserved, stream);

    var masks = [];
    for (var mask = 0; mask < 8; mask++) {
      var candidate = cloneMatrix(base);
      applyMask(candidate, reserved, mask);
      placeFormatInfo(candidate, mask);
      placeVersionInfo(candidate, version);
      masks.push({
        penalty: penalty(candidate),
        rows: candidate.map(function (row) {
          return row.map(function (b) { return b ? '1' : '0'; }).join('');
        })
      });
    }

    return { version: version, data: data, stream: stream, masks: masks };
  }

  return {
    generate: generate,
    toSvg: toSvg,
    byteCapacity: byteCapacity,
    _stages: _stages
  };
});
