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

## Android app (Expo) and OTA updates

The same UI ships as an Android app. An Expo shell renders the web app in a
WebView, so the APK and the browser run byte-identical HTML, CSS and
JavaScript — there is no second implementation to keep in sync.

`scripts/bundle-web.js` inlines `index.html`, `css/styles.css`, `js/qr.js` and
`js/app.js` into one self-contained HTML string at `src/webBundle.generated.js`,
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

Requires an Expo account. Nothing below has been run against an account yet —
`eas init` is what generates the real project ID and update URL.

```bash
npm install                 # also regenerates src/webBundle.generated.js
npx eas login
npx eas init                # adds extra.eas.projectId to app.json
npx eas update:configure    # adds updates.url to app.json
npx eas build --profile preview --platform android
```

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

Two caveats for a locally built APK:

- It is signed with the React Native template's **debug keystore**, which is
  fine for sideloading and testing but not for distribution. A Play Store
  release needs a real keystore, or EAS-managed signing.
- OTA is **inert** until `updates.url` exists in `app.json`. `Updates.isEnabled`
  reports false, the update hook no-ops, and the app runs entirely from the
  bundle baked into the APK.

`android/` and `ios/` are generated by `expo prebuild` and are gitignored —
`app.json` is the source of truth, so regenerate them rather than editing them
by hand.

### Shipping an OTA update

```bash
npm run bundle:web
npx eas update --branch preview --message "Adjust inventory thresholds"
```

Installed builds pick it up on their next launch or foreground.

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
index.html                    markup for all five screens, plus the icon sprite
css/styles.css                design tokens, phone shell, screens, native mode
js/qr.js                      QR Code encoder (also a CommonJS module)
js/app.js                     routing, camera, codes, inventory, reports
test/verify-qr.py             encoder verification against a reference impl

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
