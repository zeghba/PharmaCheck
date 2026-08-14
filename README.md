# PharmaCheck

A mobile UI for a pharmacist and pharmacy management system: scan prescriptions,
generate prescription codes by hand, track medicine stock, and read the profit
numbers behind it all.

Built as a self-contained front end — plain HTML, CSS and JavaScript, no build
step, no dependencies, no network calls.

## Running it

Open `index.html` in a browser, or serve the folder:

```
python3 -m http.server 8000
```

then visit <http://localhost:8000>.

On a desktop browser the app renders inside a phone frame. Below 460px wide (or
on a short viewport) the frame drops away and the app fills the screen, so it
also works opened directly on a phone.

The camera on the scanner screen needs `https://` or `localhost` — over
`file://` the browser blocks it and the simulated feed is used instead.

## The five screens

Navigation is the bottom tab bar: **Dashboard**, **Prescriptions**,
**Inventory**, **Reports**. Manual Entry sits under the Prescriptions tab and is
reachable from the dashboard tile or the scanner's back button.

1. **Dashboard** — greeting, three square action tiles (Scan Prescription,
   Inventory, Manual Entry), a Today's Summary block of metric cards, and recent
   activity.
2. **Prescription Scanner** — camera feed behind a glowing green viewfinder with
   an animated scan beam, a flash toggle, and a shutter button. A successful
   scan puts a green checkmark over the QR code and slides up the parsed
   prescription.
3. **Manual Entry & Code Generator** — patient, medication, dosage and quantity
   fields, then a generated QR code with a Print / Share action.
4. **Inventory** — searchable medicine stock with green/red stock-health dots,
   "Low Stock" warnings, filter chips, and a floating **+** button that opens an
   add-stock sheet.
5. **Financial Reports** — Daily / Weekly / Monthly tabs over a Net Profit
   Summary card, Total Revenue and Total COGS, a four-bar sales trend chart, and
   top profitable items with their margins.

## What is real and what is mocked

Real:

- **The QR codes.** `js/qr.js` is a QR Code Model 2 encoder written from
  ISO/IEC 18004 — byte mode, error correction level M, versions 1 to 10, with
  Reed-Solomon ECC, block interleaving, all eight mask patterns and penalty
  scoring. Codes generated on the Manual Entry screen and the one printed on the
  simulated prescription both encode their actual payload and scan with any
  reader.
- **The camera.** The scanner requests the rear camera through `getUserMedia`
  and drives the torch when the device exposes one.
- **Inventory state.** Search, filters, adding stock and filling a scanned
  prescription all mutate the same list, and the dashboard's low-stock count
  follows it.

Mocked:

- **Recognising a code from the camera.** Pressing the shutter always resolves
  to the same demo prescription; there is no decoder reading frames.
- **Dashboard and report figures**, which are fixed sample data.
- **Persistence.** Everything lives in memory and resets on reload (only the
  prescription code counter is kept, in `localStorage`).

## Verifying the QR encoder

`test/verify-qr.py` checks `js/qr.js` against the reference `qrcode` Python
package. For nine payloads spanning versions 1 to 10 it compares the full module
matrix for each of the eight mask patterns:

```
pip install qrcode
python3 test/verify-qr.py
```

## Layout

```
index.html          markup for all five screens, plus the SVG icon sprite
css/styles.css      design tokens, phone shell, per-screen styles, print sheet
js/qr.js            QR Code encoder (also usable as a CommonJS module)
js/app.js           routing, camera, code generation, inventory, reports
test/verify-qr.py   encoder verification against a reference implementation
```
