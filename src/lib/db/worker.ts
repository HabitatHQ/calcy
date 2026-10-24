// DB worker: sqlite-wasm over the OPFS SAH-pool VFS. The SAH-pool VFS
// needs no SharedArrayBuffer, so no COOP/COEP headers — works on any static host.
//
// Source of truth is the sheet text + seed; distributions are recomputed
// deterministically on load, never stored as samples.

import sqlite3InitModule, { type Database, type Sqlite3Static } from '@sqlite.org/sqlite-wasm';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sheet (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT 'Untitled',
  body        TEXT NOT NULL DEFAULT '',
  seed        INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sheet_revision (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  sheet_id  TEXT NOT NULL REFERENCES sheet(id) ON DELETE CASCADE,
  body      TEXT NOT NULL,
  saved_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS custom_unit (
  name        TEXT PRIMARY KEY,
  definition  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS sheet_fts USING fts5(title, body, content='sheet', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS sheet_ai AFTER INSERT ON sheet BEGIN
  INSERT INTO sheet_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS sheet_ad AFTER DELETE ON sheet BEGIN
  INSERT INTO sheet_fts(sheet_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS sheet_au AFTER UPDATE ON sheet BEGIN
  INSERT INTO sheet_fts(sheet_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO sheet_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
`;

// The schema above is the v1 baseline. Forward-only migrations live here keyed
// by the target user_version; each runs its statements in a transaction and
// bumps PRAGMA user_version on success. A fresh DB (or any pre-migration one,
// where user_version is still 0) adopts the baseline, then applies 2, 3, ….
// Example: 2: ['ALTER TABLE sheet ADD COLUMN folder TEXT'].
const SCHEMA_BASELINE = 1;
const MIGRATIONS: Record<number, string[]> = {};

let sqlite3: Sqlite3Static;
let db: Database;
let pool: any;
const DB_PATH = '/ucalc.sqlite';

function userVersion(): number {
  return (rows('PRAGMA user_version')[0]?.user_version as number) ?? 0;
}

// Create the schema (idempotent) and run any pending migrations. Called on init
// and after a storage wipe, so a freshly-reset DB lands on the same version.
function migrate() {
  db.exec(SCHEMA);
  // Treat the existing CREATE-IF-NOT-EXISTS schema as the baseline version, so
  // older databases (user_version 0) and brand-new ones both start at v1.
  if (userVersion() < SCHEMA_BASELINE) db.exec(`PRAGMA user_version = ${SCHEMA_BASELINE}`);
  for (let v = userVersion() + 1; ; v++) {
    const stmts = MIGRATIONS[v];
    if (!stmts) break;
    db.exec('BEGIN');
    try {
      for (const sql of stmts) db.exec(sql);
      db.exec(`PRAGMA user_version = ${v}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

async function init(): Promise<{ persistent: boolean }> {
  sqlite3 = await sqlite3InitModule();
  let persistent = true;
  try {
    pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'ucalc' });
    db = new pool.OpfsSAHPoolDb(DB_PATH);
  } catch {
    // OPFS SAH-pool access handles are exclusive per origin — another tab
    // already holds them (NoModificationAllowedError). Fall back to a transient
    // in-memory DB so this tab still works; the tab that owns OPFS keeps full
    // persistence. Nothing on disk is touched, so no data is lost.
    persistent = false;
    pool = undefined;
    db = new sqlite3.oo1.DB(':memory:', 'c');
  }
  migrate();
  return { persistent };
}

function rows(sql: string, bind: any = []): Record<string, unknown>[] {
  return db.exec({ sql, bind, rowMode: 'object', returnValue: 'resultRows' }) as unknown as Record<
    string,
    unknown
  >[];
}

function saveSheet(s: { id: string; title: string; body: string; seed: number }) {
  const now = Date.now();
  db.exec({
    sql: `INSERT INTO sheet (id, title, body, seed, created_at, updated_at)
		      VALUES ($id, $title, $body, $seed, $now, $now)
		      ON CONFLICT(id) DO UPDATE SET title=$title, body=$body, seed=$seed, updated_at=$now`,
    bind: { $id: s.id, $title: s.title, $body: s.body, $seed: s.seed, $now: now }
  });
}

function snapshotRevision(id: string, body: string) {
  db.exec({
    sql: 'INSERT INTO sheet_revision (sheet_id, body, saved_at) VALUES ($id, $body, $now)',
    bind: { $id: id, $body: body, $now: Date.now() }
  });
}

function deleteSheet(id: string) {
  db.exec({ sql: 'DELETE FROM sheet WHERE id = $id', bind: { $id: id } });
}

function listRevisions(sheetId: string) {
  return rows(
    `SELECT id, saved_at, substr(body, 1, 80) AS snippet
		 FROM sheet_revision WHERE sheet_id = $id ORDER BY saved_at DESC LIMIT 50`,
    { $id: sheetId }
  );
}

function loadRevision(id: number) {
  const r = rows('SELECT body FROM sheet_revision WHERE id = $id', { $id: id });
  return r[0] ?? null;
}

function loadLast() {
  const r = rows('SELECT id, title, body, seed FROM sheet ORDER BY updated_at DESC LIMIT 1');
  return r[0] ?? null;
}

function loadSheet(id: string) {
  const r = rows('SELECT id, title, body, seed FROM sheet WHERE id = $id', { $id: id });
  return r[0] ?? null;
}

function listSheets() {
  return rows('SELECT id, title, updated_at FROM sheet ORDER BY updated_at DESC');
}

function search(q: string) {
  if (!q.trim()) return listSheets();
  // FTS5 MATCH throws on syntax like a bare `*`; fall back to a prefix query.
  const term = `${q.trim().replace(/["*]/g, ' ').trim()}*`;
  try {
    return rows(
      `SELECT s.id, s.title, s.updated_at,
			        snippet(sheet_fts, 1, '«', '»', '…', 8) AS snippet
			 FROM sheet_fts JOIN sheet s ON s.rowid = sheet_fts.rowid
			 WHERE sheet_fts MATCH $q ORDER BY rank`,
      { $q: term }
    );
  } catch {
    return [];
  }
}

function getCustomUnits(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows('SELECT name, definition FROM custom_unit'))
    out[r.name as string] = r.definition as string;
  return out;
}

function setCustomUnit(name: string, definition: string) {
  db.exec({
    sql: `INSERT INTO custom_unit (name, definition) VALUES ($n, $d)
		      ON CONFLICT(name) DO UPDATE SET definition=$d`,
    bind: { $n: name, $d: definition }
  });
}

function deleteCustomUnit(name: string) {
  db.exec({ sql: 'DELETE FROM custom_unit WHERE name = $n', bind: { $n: name } });
}

function getSettings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows('SELECT key, value FROM setting')) out[r.key as string] = r.value as string;
  return out;
}

function setSetting(key: string, value: string) {
  db.exec({
    sql: 'INSERT INTO setting (key, value) VALUES ($k, $v) ON CONFLICT(key) DO UPDATE SET value=$v',
    bind: { $k: key, $v: value }
  });
}

function exportBytes(): Uint8Array {
  // SAH-pool has a fast path; the in-memory fallback serialises via the C API.
  if (pool) return pool.exportFile(DB_PATH);
  const ptr = db.pointer;
  if (ptr == null) throw new Error('database is not open');
  return sqlite3.capi.sqlite3_js_db_export(ptr);
}

async function importBytes(bytes: Uint8Array) {
  if (!pool) throw new Error('import is unavailable here — calcy is open in another tab');
  // SAHPool validates only the SQLite header before overwriting its slot.
  // Preserve an exact copy so failed writes or integrity/schema checks restore
  // the prior database rather than leaving an unusable file behind.
  const original = pool.exportFile(DB_PATH);
  db.close();
  try {
    await pool.importDb(DB_PATH, bytes);
    db = new pool.OpfsSAHPoolDb(DB_PATH);
    const integrity = rows('PRAGMA integrity_check')[0]?.integrity_check;
    if (integrity !== 'ok') throw new Error('imported database failed SQLite integrity check');
    rows('SELECT id, title, body, seed FROM sheet LIMIT 0');
    rows('SELECT name, definition FROM custom_unit LIMIT 0');
    rows('SELECT key, value FROM setting LIMIT 0');
  } catch (error) {
    try {
      db.close();
    } catch {
      // The pool import itself may fail before a replacement DB is opened.
    }
    await pool.importDb(DB_PATH, original);
    db = new pool.OpfsSAHPoolDb(DB_PATH);
    throw error;
  }
}

// The three tables a JSON backup carries (the shell wraps these in the
// versioned envelope; see $lib/sheet/backup).
function exportData() {
  return {
    sheets: rows(
      'SELECT id, title, body, seed, created_at, updated_at FROM sheet ORDER BY created_at'
    ),
    custom_units: getCustomUnits(),
    settings: getSettings()
  };
}

// Merge an already-validated backup: INSERT OR IGNORE keeps existing rows, so a
// re-import never clobbers local edits. One transaction so a mid-import failure
// leaves the database untouched.
function importData(d: {
  sheets: {
    id: string;
    title: string;
    body: string;
    seed: number;
    created_at: number;
    updated_at: number;
  }[];
  custom_units: Record<string, string>;
  settings: Record<string, string>;
}) {
  db.exec('BEGIN');
  try {
    for (const s of d.sheets) {
      db.exec({
        sql: `INSERT OR IGNORE INTO sheet (id, title, body, seed, created_at, updated_at)
				      VALUES ($id, $title, $body, $seed, $created, $updated)`,
        bind: {
          $id: s.id,
          $title: s.title,
          $body: s.body,
          $seed: s.seed,
          $created: s.created_at,
          $updated: s.updated_at
        }
      });
    }
    for (const [name, definition] of Object.entries(d.custom_units))
      db.exec({
        sql: 'INSERT OR IGNORE INTO custom_unit (name, definition) VALUES ($n, $d)',
        bind: { $n: name, $d: definition }
      });
    for (const [key, value] of Object.entries(d.settings))
      db.exec({
        sql: 'INSERT OR IGNORE INTO setting (key, value) VALUES ($k, $v)',
        bind: { $k: key, $v: value }
      });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Danger zone: delete every sheet + its revision history (the FTS triggers keep
// the index in sync). Custom units and settings are left intact.
function clearSheets() {
  db.exec('DELETE FROM sheet_revision');
  db.exec('DELETE FROM sheet');
}

// Danger zone: drop all settings and custom units; sheets are untouched.
function resetUserData() {
  db.exec('DELETE FROM setting');
  db.exec('DELETE FROM custom_unit');
}

// Here be dragons: wipe the whole on-device store and rebuild an empty schema.
async function wipeStorage() {
  if (!pool) throw new Error('wiping storage is unavailable here — calcy is open in another tab');
  db.close();
  await pool.wipeFiles();
  db = new pool.OpfsSAHPoolDb(DB_PATH);
  migrate();
}

self.onmessage = async (e: MessageEvent) => {
  const { id, type, payload } = e.data;
  try {
    let result: unknown = null;
    switch (type) {
      case 'init':
        result = await init();
        break;
      case 'save':
        saveSheet(payload);
        break;
      case 'snapshot':
        snapshotRevision(payload.id, payload.body);
        break;
      case 'delete':
        deleteSheet(payload.id);
        break;
      case 'loadLast':
        result = loadLast();
        break;
      case 'listRevisions':
        result = listRevisions(payload.sheetId);
        break;
      case 'loadRevision':
        result = loadRevision(payload.id);
        break;
      case 'deleteCustomUnit':
        deleteCustomUnit(payload.name);
        break;
      case 'loadSheet':
        result = loadSheet(payload.id);
        break;
      case 'list':
        result = listSheets();
        break;
      case 'search':
        result = search(payload.q);
        break;
      case 'customUnits':
        result = getCustomUnits();
        break;
      case 'setCustomUnit':
        setCustomUnit(payload.name, payload.definition);
        break;
      case 'getSettings':
        result = getSettings();
        break;
      case 'setSetting':
        setSetting(payload.key, payload.value);
        break;
      case 'export':
        result = exportBytes();
        break;
      case 'import':
        await importBytes(payload.bytes);
        break;
      case 'exportData':
        result = exportData();
        break;
      case 'importData':
        importData(payload);
        break;
      case 'clearSheets':
        clearSheets();
        break;
      case 'resetUserData':
        resetUserData();
        break;
      case 'wipeStorage':
        await wipeStorage();
        break;
    }
    (self as unknown as Worker).postMessage({ id, result });
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id,
      error: err instanceof Error ? err.message : String(err)
    });
  }
};
