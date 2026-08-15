/* =====================================================================
   The per-pharmacy schema.

   One database per pharmacy, so a pharmacy's rows are isolated by the
   database boundary rather than by a `WHERE pharmacy_id = ?` that any
   forgotten clause could leak through.

   Column names mirror the field names the app already uses, snake-cased.
   `prescriptions.items` stays JSON: the app treats a prescription's lines
   as one indivisible record and never queries across them.
   ===================================================================== */

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (
     key   TEXT PRIMARY KEY,
     value TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS accounts (
     id         TEXT PRIMARY KEY,
     name       TEXT NOT NULL,
     role       TEXT NOT NULL CHECK (role IN ('manager','vendor')),
     pin_hash   TEXT NOT NULL,
     pin_salt   TEXT NOT NULL,
     active     INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS medicines (
     name           TEXT PRIMARY KEY,
     strength       TEXT NOT NULL DEFAULT '',
     form           TEXT NOT NULL DEFAULT 'comprime',
     packaging      TEXT NOT NULL DEFAULT 'boite',
     qty            INTEGER NOT NULL DEFAULT 0,
     reorder_level  INTEGER NOT NULL DEFAULT 0,
     batch          TEXT NOT NULL DEFAULT '',
     expiry         TEXT NOT NULL DEFAULT '',
     price          REAL NOT NULL DEFAULT 0,
     cost           REAL NOT NULL DEFAULT 0,
     barcode        TEXT NOT NULL DEFAULT '',
     updated_at     INTEGER NOT NULL
   )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS medicines_barcode
     ON medicines(barcode) WHERE barcode <> ''`,

  `CREATE TABLE IF NOT EXISTS sales (
     id          TEXT PRIMARY KEY,
     vendor_id   TEXT NOT NULL,
     vendor_name TEXT NOT NULL DEFAULT '',
     medicine    TEXT NOT NULL,
     barcode     TEXT NOT NULL DEFAULT '',
     boxes       INTEGER NOT NULL,
     unit_price  REAL NOT NULL,
     unit_cost   REAL NOT NULL,
     at          INTEGER NOT NULL,
     source      TEXT NOT NULL DEFAULT 'scan'
   )`,

  `CREATE INDEX IF NOT EXISTS sales_at ON sales(at)`,
  `CREATE INDEX IF NOT EXISTS sales_vendor ON sales(vendor_id, at)`,

  `CREATE TABLE IF NOT EXISTS prescriptions (
     code       TEXT PRIMARY KEY,
     patient    TEXT NOT NULL DEFAULT '',
     prescriber TEXT NOT NULL DEFAULT '',
     items      TEXT NOT NULL,
     status     TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     filled_at  INTEGER,
     source     TEXT NOT NULL DEFAULT 'manual'
   )`,

  `CREATE INDEX IF NOT EXISTS prescriptions_filled ON prescriptions(status, filled_at)`
];
