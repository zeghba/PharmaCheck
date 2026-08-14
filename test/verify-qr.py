#!/usr/bin/env python3
"""Verify js/qr.js against the reference `qrcode` Python library.

    pip install qrcode
    python3 test/verify-qr.py

For each payload and each of the eight mask patterns, the module matrix
produced by js/qr.js must be identical to the reference encoder's. That
covers byte-mode encoding, Reed-Solomon ECC, block interleaving, function
patterns, data placement, masking, format info and version info.

Note on mask selection: this script compares mask-by-mask rather than
comparing final symbols. python-qrcode scores candidate masks with the
format modules blanked (`makeImpl(test=True, ...)`), while js/qr.js scores
the finished symbol as ISO/IEC 18004 describes. The two therefore pick
different masks for some payloads. Any of the eight is a valid, scannable
symbol, so the mask-by-mask comparison is the meaningful check; the script
additionally asserts that js/qr.js emits the candidate it scored lowest.
"""

import json
import subprocess
import sys
from pathlib import Path

try:
    import qrcode
    from qrcode import constants
    from qrcode.main import QRCode
    from qrcode.util import QRData, MODE_8BIT_BYTE
except ImportError:
    sys.exit("This script needs the reference encoder: pip install qrcode")

QR_JS = Path(__file__).resolve().parent.parent / "js" / "qr.js"

CASES = [
    "hello",
    "PC-2024-0001",
    "PHARMACHECK|RX|SARAH|AMOXICILLIN 500MG|3x/day|21",
    "Ünïcödé påtiënt nàme — 30mg",
    "A" * 40,
    "B" * 90,
    "C" * 150,
    "D" * 211,
    # Multi-medicine prescriptions push well past the old version-10 ceiling.
    "E" * 300,
    "F" * 500,
    "G" * 900,
    "H" * 1400,
    "I" * 1800,
    "J" * 2331,   # version 40, the largest payload supported
]

NODE_SCRIPT = """
const qr = require(process.argv[1]);
const cases = JSON.parse(process.argv[2]);
console.log(JSON.stringify(cases.map(function (text) {
  const stages = qr._stages(text);
  const final = qr.generate(text);
  const rows = final.modules.map(r => r.map(b => (b ? '1' : '0')).join('')).join('|');
  return {
    version: final.version,
    size: final.size,
    penalties: stages.masks.map(m => m.penalty),
    emitted: stages.masks.findIndex(m => m.rows.join('|') === rows),
    masks: stages.masks.map(m => m.rows)
  };
})));
"""


def reference_matrix(text, mask):
    qr = QRCode(error_correction=constants.ERROR_CORRECT_M, border=0, mask_pattern=mask)
    qr.add_data(QRData(text.encode("utf-8"), mode=MODE_8BIT_BYTE))
    qr.make(fit=True)
    return qr.version, ["".join("1" if c else "0" for c in row) for row in qr.get_matrix()]


def main():
    proc = subprocess.run(
        ["node", "-e", NODE_SCRIPT, str(QR_JS), json.dumps(CASES)],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.exit("node failed:\n" + proc.stderr)
    results = json.loads(proc.stdout)

    failures = 0
    for text, got in zip(CASES, results):
        label = text if len(text) <= 34 else text[:31] + "..."
        problems = []

        for mask in range(8):
            ref_version, ref_rows = reference_matrix(text, mask)
            if ref_version != got["version"]:
                problems.append(
                    f"version mismatch (ref v{ref_version}, got v{got['version']})"
                )
                break
            if ref_rows != got["masks"][mask]:
                differing = sum(
                    a != b
                    for r1, r2 in zip(ref_rows, got["masks"][mask])
                    for a, b in zip(r1, r2)
                )
                problems.append(f"mask {mask}: {differing} modules differ")

        lowest = got["penalties"].index(min(got["penalties"]))
        if got["emitted"] != lowest:
            problems.append(
                f"emitted mask {got['emitted']} but scored mask {lowest} lowest"
            )

        if problems:
            failures += 1
            print(f"FAIL  v{got['version']:<3} {len(text):>3} chars  {label!r}")
            for p in problems:
                print("        " + p)
        else:
            print(
                f"ok    v{got['version']:<3} {len(text):>3} chars  "
                f"{got['size']}x{got['size']}  mask {got['emitted']}  {label!r}"
            )

    print()
    if failures:
        print(f"{failures} of {len(CASES)} payloads FAILED")
        return 1
    print(f"All {len(CASES)} payloads match the reference encoder across all 8 masks.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
