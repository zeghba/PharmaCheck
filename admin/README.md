# PharmaCheck Admin

A separate Android app for whoever runs the estate rather than a counter. It
creates pharmacies, hands out their manager and vendor accounts, and holds the
one screen that says what the whole system is connected to.

It is its own Expo project — its own package id (`com.pharmacheck.admin`), its
own APK, installed alongside the pharmacy app rather than replacing it. A phone
on a shop floor never contains this code.

## What it does

**Overview** — how many pharmacies, accounts, medicines and sales exist across
everything, and a card per pharmacy. A pharmacy whose database cannot be
reached is listed and marked, not hidden: a broken one should not look like an
absent one.

**Pharmacies** — search the list, open one, or create a new one. Creating a
pharmacy makes it a Turso database of its own, applies the schema and writes
its first manager, in one step that takes a few seconds.

**One pharmacy** — its database, its stock and sales figures, and its accounts
split into managers and vendors. From here you can add a manager or a vendor,
rename one, reset a PIN, switch someone off, or remove them. It ends with the
two values a phone needs typed into the pharmacy app's Connect screen.

**Settings** — three numbered steps: the Worker, the Turso credentials, and a
checklist of the Worker secrets with the exact `wrangler` command for anything
missing.

## Guards worth knowing about

- **The last active manager cannot be switched off or removed.** A pharmacy
  with no manager cannot be administered from a phone at all.
- **An account with sales on record is deactivated rather than deleted**, so
  the figures those sales feed into stay explainable.
- **Archiving a pharmacy keeps its database by default.** Phones stop being
  able to reach it, but the records survive and recreating it with the same
  code brings it back. Deleting the data is a second switch, off by default,
  and either path makes you type the pharmacy code out first.
- **The setup key is never stored.** It is typed at sign-in, exchanged for a
  session that expires in 8 hours, and forgotten — so a lost handset costs a
  working day of access, not the key itself.
- **An admin session cannot act as a pharmacy**, and a manager or vendor token
  cannot reach any admin route. The two are different claims on a signed token
  and neither can be edited into the other.

## Where the Turso credentials go

There are two ways to give the Worker its Turso credentials, and Settings shows
which one is in force:

| | Where the token travels | 
|---|---|
| `wrangler secret put TURSO_PLATFORM_TOKEN` | your machine → Cloudflare. Never touches a phone. |
| Settings → Turso database | typed on the handset → the Worker, which stores it. Crosses one device, once. |

A secret set with wrangler always wins, so configuring it properly later
silently retires whatever the app stored. The token is never sent back to the
app — Settings can tell you that one exists, not what it is.

## Building the APK

The Android SDK and a JDK are all it needs — no Expo account, no cloud build:

```bash
cd admin
npm install
export ANDROID_HOME=/path/to/android-sdk
npm run apk
# → android/app/build/outputs/apk/release/app-release.apk
```

`npm run apk` regenerates the inlined web bundle, runs `expo prebuild`, and
builds. `android/` is generated output and is gitignored — `app.json` is the
source of truth, so regenerate it rather than editing it by hand.

The APK is signed with the React Native template's **debug keystore**. That is
fine for sideloading, which is how this app is meant to be installed. A Play
Store release would need a real keystore.

There is no OTA update path here, deliberately: an app that can create and
destroy databases should not be able to rewrite itself from the network.
Updating it means installing a new APK.

## Layout

```
web/index.html              markup for all five screens, plus the icon sprite
web/css/styles.css          the pharmacy app's design language, in a darker key
web/js/api.js               the client for the Worker's admin API
web/js/app.js               routing, screens, sheets
App.js                      native shell: WebView + status bar + back button
scripts/bundle-web.js       inlines web/ into src/webBundle.generated.js
```
