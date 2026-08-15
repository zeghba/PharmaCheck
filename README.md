# PharmaCheck

A mobile UI for a pharmacist and pharmacy management system: scan prescriptions,
generate prescription codes by hand, track medicine stock, and read the profit
numbers behind it all.

Built as a self-contained front end — plain HTML, CSS and JavaScript, no build
step and no dependencies. It runs entirely offline by default; connecting it to
a shared database is opt-in, and set up from the app's own Settings tab.

## Running it

Open `index.html` in a browser, or serve the folder:

```
python3 -m http.server 8000
```

then visit <http://localhost:8000>.

On a desktop browser the app renders inside a phone frame. Below 460px wide (or
on a short viewport) the frame drops away and the app fills the screen, so it
also works opened directly on a phone.

The camera on the scanner screen needs `https://` or `localhost`. Over
`file://` the browser blocks it and the scanner shows a camera-unavailable
state pointing at manual entry.

## The screens

Navigation is the bottom tab bar: **Dashboard**, **Prescriptions**,
**Inventory**, **Vendors**, **Reports**, **Settings**. Manual Entry sits under
the Prescriptions tab and is reachable from the dashboard tile or the scanner's
back button. Vendors get a shorter bar of their own: Stock, Sell, My Sales.

1. **Dashboard** — greeting, three square action tiles (Scan Prescription,
   Inventory, Manual Entry), a Today's Summary block of metric cards, and recent
   activity.
2. **Prescription Scanner** — live camera behind a glowing green viewfinder with
   an animated scan beam, a torch toggle, and a shutter. Codes are decoded
   continuously; a hit locks the frame with a green checkmark and slides up
   what the code actually contains, ready to dispense.
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

- **Scanning.** `js/scanner.js` decodes live camera frames — the platform
  `BarcodeDetector` where available (the Android WebView, Chrome), falling back
  to a vendored jsQR build everywhere else. Decoding runs continuously; the
  shutter forces a single attempt. A decoded code is resolved against the
  records, so the result sheet reports what the code actually contains,
  including when it is already dispensed, unknown to this pharmacy, or not a
  PharmaCheck code at all.
- **The QR codes.** `js/qr.js` is a QR Code Model 2 encoder written from
  ISO/IEC 18004 — byte mode, error correction level M, versions 1 to 10, with
  Reed-Solomon ECC, block interleaving, all eight mask patterns and penalty
  scoring. Codes it generates scan with any reader, and with this app.
- **The data.** `js/store.js` holds medicines (with price and cost) and
  prescriptions (with status and timestamps), persisted to `localStorage`.
  Every number on the dashboard and the reports screen — counts, revenue,
  COGS, profit, trend bars, margins — is computed from those records. Nothing
  on screen is a literal.
- **Stock movement.** Dispensing is the only path that moves stock, and it
  refuses rather than going negative.

Seeded, not mocked:

- Four months of trading history is generated deterministically on first run,
  so the reports screen has something to aggregate before you have used the
  app. Those records carry `source: "seed"`, which distinguishes them from
  prescriptions actually handled here. `PharmaStore.reset()` regenerates them.

Still fixed:

- The pharmacist identity in the header ("Welcome, Sarah") and the pharmacy
  name.

## Several phones, one pharmacy

By default nothing leaves the handset. **Settings** offers two ways out of that,
and the difference between them is who gets to decide what a box was worth.

### Shared pharmacy (recommended)

A small Cloudflare Worker in [`worker/`](worker/README.md) — around 900 lines,
no framework — plus one Turso database per pharmacy.

The app stays local-first: every screen still reads the copy on the device, so
the counter works with no signal. What the Worker adds is agreement between
devices, and one thing a phone cannot be trusted with.

That thing is pricing. Turso scopes database tokens by table and action, not by
column. A token that lets a vendor decrement `qty` to record a sale is
necessarily a token that lets them rewrite `price` and `cost` — the two numbers
their pay is calculated from. So vendors hold no write path to the database at
all: sales go to the Worker, which reads the price out of its own row and
ignores whatever the device claimed.

| | Reads | Writes |
|---|---|---|
| Manager | local copy, synced | through the Worker, all operations |
| Vendor | local copy, synced | through the Worker, sales only |

Mutations queue in an outbox and drain when there is a connection, so a sale
made with no signal is recorded and syncs later rather than being refused. Every
queued operation carries a client-generated id, so replaying the outbox after a
dropped connection cannot bill the same box twice.

PINs stop being plaintext in this mode: they are stored as PBKDF2-SHA256 with a
per-account salt and checked server-side, and sign-in locks an account for 15
minutes after 8 wrong attempts. A 4-digit PIN is still only worth so much, which
is why it is not the boundary — the session token is. See
[worker/README.md](worker/README.md#what-the-pin-is-worth).

Setup is three commands and a form: deploy the Worker, then fill in **Settings →
Shared pharmacy** and press *Set up a new pharmacy*. Full steps in
[worker/README.md](worker/README.md).

### Turso directly

Database URL and auth token typed straight into Settings, no Worker to deploy.
The app mirrors its state into your own Turso database and can restore from it.

There is no server in this mode, so there is no price protection: anything the
device can read it can also rewrite. It is a backup and a second-manager-device
story, not a way to hand a phone to someone whose pay depends on the numbers on
it. Settings says so on the screen.

### What lives where

The Settings screen ends with this table, because the whole design turns on it:

| | Where | Why |
|---|---|---|
| Worker URL, pharmacy code | the phone | an address and a name, neither secret |
| Setup key | typed, never stored | only needed to create a pharmacy |
| Turso platform token | **the Worker only** | can create and destroy every database you own |
| Session secret | **the Worker only** | signs sign-in tokens |
| Database token | direct mode only | full read and write over one database |

The platform token is never sent to a device and there is no field for it in the
app. It goes in with `wrangler secret put`.

### Offline

Local mode is fully offline, as before. In shared mode reads are local so the
counter keeps working, and writes queue — but the **first** sign-in on a device
needs a connection, because the PIN is checked by the server. After that the
session lasts 12 hours.

## Verifying the QR encoder

`test/verify-qr.py` checks `js/qr.js` against the reference `qrcode` Python
package. For nine payloads spanning versions 1 to 10 it compares the full module
matrix for each of the eight mask patterns:

```
pip install qrcode
python3 test/verify-qr.py
```

## Android app (Expo) and OTA updates

The same UI ships as an Android app. An Expo shell renders the web app in a
WebView, so the APK and the browser run byte-identical HTML, CSS and
JavaScript — there is no second implementation to keep in sync.

`scripts/bundle-web.js` inlines `index.html` and every local stylesheet and
script it references into one self-contained HTML string at
`src/webBundle.generated.js`,
which the WebView renders via `source={{ html }}`. Because the whole UI lives
inside the JS bundle, **every part of the interface is updatable over the air** —
a CSS tweak or a new screen ships without a new APK.

The shell adds the things a web page cannot do for itself:

- **OTA updates** (`src/useOtaUpdates.js`) — checks on launch and on every
  return to the foreground, rate-limited to once every 5 minutes. A downloaded
  update never applies itself mid-task; a banner offers a restart and the user
  decides. Offline or unreachable-server failures are swallowed, leaving the app
  on the bundle it already has.
- **Real status bar**, tinted per screen — it turns dark when the scanner opens.
- **Safe-area insets.** Android 15+ draws edge to edge, so the shell pads the
  WebView by the measured insets; without it the header slides under the clock
  and the tab bar under the gesture bar.
- **Android hardware back**, routed into the app: closes an open sheet, then a
  scan result, then walks back to the dashboard before letting the system exit.

Inside the shell the web app sets `html.is-native`, which drops the simulated
status bar and home indicator so the device's own chrome shows instead.

### Building it

The project is linked to `@xp49/pharmacheck`, with `updates.url` and the
`preview` channel already configured in `app.json`. To build on EAS:

```bash
npm install                 # also regenerates src/webBundle.generated.js
export EXPO_TOKEN=...       # or: npx eas login
npx eas build --profile preview --platform android
```

An EAS build is signed with an EAS-managed keystore. That differs from the
local debug keystore below, so an EAS build will not install over a locally
built one — uninstall first when switching between them.

The `preview` profile in `eas.json` sets `buildType: "apk"` with internal
distribution, so it produces an installable APK rather than a Play Store bundle.

### Building an APK without an Expo account

EAS is the convenient path, not the only one. The same project compiles
locally with just a JDK and the Android SDK — no account, no cloud build:

```bash
export ANDROID_HOME=/path/to/android-sdk
npx expo prebuild --platform android --clean
cd android && ./gradlew assembleRelease
# → android/app/build/outputs/apk/release/app-release.apk
```

One caveat for a locally built APK: it is signed with the React Native
template's **debug keystore**, which is fine for sideloading and testing but
not for distribution. A Play Store release needs a real keystore, or
EAS-managed signing.

OTA works from a local build, because both the update URL and the channel are
pinned in `app.json` rather than injected by EAS Build.

`android/` and `ios/` are generated by `expo prebuild` and are gitignored —
`app.json` is the source of truth, so regenerate them rather than editing them
by hand.

### Shipping an OTA update

```bash
npm run bundle:web
npx eas update --branch preview --environment preview --message "..."
```

Installed builds pick it up on their next launch or foreground.

The channel is pinned in `app.json` via
`updates.requestHeaders["expo-channel-name"]`. EAS Build injects the channel
from the `eas.json` profile, but a Gradle build run outside EAS does not get
it — and without a channel the app sends no branch to match, so updates never
arrive. Pinning it in app config makes this work regardless of who builds.

**The one rule:** `runtimeVersion` uses the `appVersion` policy, so an update
only reaches builds with a matching `version` in `app.json`. Changing JS, CSS or
HTML is fine over the air. Changing anything native — bumping the Expo SDK,
adding a config plugin, changing permissions — needs a version bump and a fresh
APK, or existing installs will simply ignore the update.

Until `eas init` and `eas update:configure` have run, `Updates.isEnabled` is
false, the update hook no-ops, and the app runs as a plain offline shell.

### Verified so far

`npx expo export --platform android` bundles cleanly (598 modules) and
`npx expo-doctor` passes 20/20. The inlined bundle was exercised in a headless
browser with the native bridge stubbed: screen messages, hardware-back routing,
QR generation and the native-chrome rules all behave. The EAS build and OTA
publish themselves are unrun — they need your account.

## Layout

```
index.html                    markup for every screen, plus the icon sprite
css/styles.css                design tokens, phone shell, screens, native mode
js/qr.js                      QR Code encoder (also a CommonJS module)
js/store.js                   records, derived figures, and the sync outbox
js/cloud.js                   sync client — Worker mode and direct Turso mode
js/app.js                     routing, camera, codes, inventory, reports
test/verify-qr.py             encoder verification against a reference impl

worker/                       the sync Worker — see worker/README.md
worker/src/index.js           routes, and the role check that actually counts
worker/src/turso.js           Turso Platform API; the only user of the token
worker/src/hrana.js           libSQL over HTTP
worker/test/worker.test.js    node --test, no network needed

App.js                        native shell: WebView + status bar + back button
index.js                      Expo entry point
src/useOtaUpdates.js          OTA check / download / apply lifecycle
src/UpdateBanner.js           "Update ready — Restart" banner
src/webBundle.generated.js    generated; the inlined single-file web app
scripts/bundle-web.js         the inliner (postinstall, prestart, bundle:web)
app.json / eas.json           Expo config and build profiles
assets/                       app icon, adaptive icon, splash
```

`src/webBundle.generated.js` is committed so a build works even with install
scripts disabled, but it is generated output — edit the web sources and rerun
`npm run bundle:web` rather than touching it.

`worker/` is deployed separately with `wrangler` and is not part of the app
bundle; nothing in it ships inside the APK.
