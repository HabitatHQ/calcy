// DB worker: sqlite-wasm over the OPFS SAH-pool VFS. The SAH-pool VFS
// needs no SharedArrayBuffer, so no COOP/COEP headers — works on any static host.
//
// Source of truth is the sheet text + seed; distributions are recomputed
// deterministically on load, never stored as samples.

import sqlite3InitModule, { type Database, type Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import { DEFAULT_OPTIONS, Engine } from '../engine';
import { parseSettings } from '../sheet/settings';

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
  validateUnits({ ...getCustomUnits(), [name]: definition }, getSettings());
  db.exec({
    sql: `INSERT INTO custom_unit (name, definition) VALUES ($n, $d)
		      ON CONFLICT(name) DO UPDATE SET definition=$d`,
    bind: { $n: name, $d: definition }
  });
}

function deleteCustomUnit(name: string) {
  const { [name]: _removed, ...remaining } = getCustomUnits();
  validateUnits(remaining, getSettings());
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

// Tables and columns every calcy database must have. The FTS index is derived
// from `sheet`, so it is (re)created by migrate() and is not required.
const REQUIRED_SCHEMA: Record<string, string[]> = {
  sheet: ['id', 'title', 'body', 'seed', 'created_at', 'updated_at'],
  sheet_revision: ['id', 'sheet_id', 'body', 'saved_at'],
  custom_unit: ['name', 'definition'],
  setting: ['key', 'value']
};

// Run a query against an arbitrary handle (the live DB or a scratch copy).
function query(handle: Database, sql: string): Record<string, unknown>[] {
  return handle.exec({ sql, rowMode: 'object', returnValue: 'resultRows' }) as unknown as Record<
    string,
    unknown
  >[];
}

// Open the candidate bytes in a throwaway in-memory database so they can be
// checked *before* the live database is touched. `sqlite3_deserialize` takes
// ownership of the buffer (SQLITE_DESERIALIZE_FREEONCLOSE), so it must be
// allocated with sqlite3_malloc — wasm.alloc() does exactly that.
function openScratch(bytes: Uint8Array): Database {
  const scratch = new sqlite3.oo1.DB(':memory:', 'c');
  const dbPointer = scratch.pointer;
  if (dbPointer == null) throw new Error('could not open a database for validation');
  // SQLite recommends 20 bytes of padding when deserializing untrusted data.
  const capacity = bytes.byteLength + 20;
  const ptr = sqlite3.wasm.alloc(capacity);
  const heap = sqlite3.wasm.heap8u();
  heap.set(bytes, ptr);
  heap.fill(0, ptr + bytes.byteLength, ptr + capacity);
  const rc = sqlite3.capi.sqlite3_deserialize(
    dbPointer,
    'main',
    ptr,
    bytes.byteLength,
    capacity,
    1 | 2 // SQLITE_DESERIALIZE_FREEONCLOSE | SQLITE_DESERIALIZE_RESIZEABLE
  );
  if (rc !== 0) {
    // FREEONCLOSE also frees the buffer on a failed deserialize.
    scratch.close();
    throw new Error('that file is not a calcy database');
  }
  return scratch;
}

// Validate the candidate bytes without touching the live database: the file
// must be a readable SQLite database, pass its integrity check, carry the
// calcy schema, and expose its custom units and settings for the caller to
// check before anything is replaced.
function inspectBytes(bytes: Uint8Array): void {
  if (bytes.byteLength < 512) throw new Error('that file is too small to be a calcy database');
  const header = new TextDecoder().decode(bytes.subarray(0, 15));
  if (header !== 'SQLite format 3') throw new Error('that file is not an SQLite database');
  const scratch = openScratch(bytes);
  try {
    const integrity = query(scratch, 'PRAGMA integrity_check')[0]?.integrity_check;
    if (integrity !== 'ok') throw new Error('imported database failed its integrity check');
    const version = (query(scratch, 'PRAGMA user_version')[0]?.user_version as number) ?? 0;
    if (version > Math.max(SCHEMA_BASELINE, ...Object.keys(MIGRATIONS).map(Number)))
      throw new Error('that database was made by a newer version of calcy');
    for (const [table, columns] of Object.entries(REQUIRED_SCHEMA)) {
      const present = query(scratch, `PRAGMA table_info(${table})`).map((r) => r.name as string);
      if (!present.length) throw new Error(`imported database is missing the ${table} table`);
      const missing = columns.filter((c) => !present.includes(c));
      if (missing.length)
        throw new Error(
          `imported database is missing the ${table}.${missing.join(', ')} column(s)`
        );
    }
    for (const row of query(
      scratch,
      'SELECT id, title, body, seed, created_at, updated_at FROM sheet'
    )) {
      if (
        typeof row.id !== 'string' ||
        !row.id ||
        typeof row.title !== 'string' ||
        typeof row.body !== 'string' ||
        ![row.seed, row.created_at, row.updated_at].every(
          (value) => typeof value === 'number' && Number.isFinite(value)
        )
      )
        throw new Error('invalid sheet row in imported database');
    }
    for (const row of query(scratch, 'SELECT id, sheet_id, body, saved_at FROM sheet_revision')) {
      if (
        typeof row.id !== 'number' ||
        !Number.isSafeInteger(row.id) ||
        typeof row.sheet_id !== 'string' ||
        typeof row.body !== 'string' ||
        typeof row.saved_at !== 'number' ||
        !Number.isFinite(row.saved_at)
      )
        throw new Error('invalid revision row in imported database');
    }
    const custom_units: Record<string, string> = {};
    for (const r of query(scratch, 'SELECT name, definition FROM custom_unit ORDER BY rowid'))
      if (typeof r.name !== 'string' || typeof r.definition !== 'string')
        throw new Error('invalid custom unit row');
      else custom_units[r.name] = r.definition;
    const settings: Record<string, string> = {};
    for (const r of query(scratch, 'SELECT key, value FROM setting ORDER BY rowid'))
      if (typeof r.key !== 'string' || typeof r.value !== 'string')
        throw new Error('invalid setting row');
      else settings[r.key] = r.value;
    validateUnits(custom_units, settings);
  } catch (error) {
    throw new Error(
      `that file is not a valid calcy database: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    scratch.close();
  }
}

function validateUnits(units: Record<string, string>, settings: Record<string, string>): void {
  const parsed = parseSettings(settings);
  new Engine(
    {
      monthDays: parsed.monthDays ?? DEFAULT_OPTIONS.monthDays,
      yearDays: parsed.yearDays ?? DEFAULT_OPTIONS.yearDays
    },
    units
  );
}

// Replace the live database with `bytes`, keeping an exact copy so a failed
// write or a failed post-import check restores the previous database instead of
// leaving an unusable file behind.
async function replaceBytes(bytes: Uint8Array) {
  if (!pool) throw new Error('import is unavailable here — calcy is open in another tab');
  inspectBytes(bytes);
  const original = await pool.exportFile(DB_PATH);
  db.close();
  try {
    await pool.importDb(DB_PATH, bytes);
    db = new pool.OpfsSAHPoolDb(DB_PATH);
    migrate();
    const integrity = rows('PRAGMA integrity_check')[0]?.integrity_check;
    if (integrity !== 'ok') throw new Error('imported database failed SQLite integrity check');
    for (const [table, columns] of Object.entries(REQUIRED_SCHEMA)) {
      const present = rows(`PRAGMA table_info(${table})`).map((r) => r.name as string);
      const missing = columns.filter((c) => !present.includes(c));
      if (missing.length)
        throw new Error(
          `imported database is missing the ${table}.${missing.join(', ')} column(s)`
        );
    }
  } catch (error) {
    try {
      db.close();
    } catch {
      // The pool import itself may fail before a replacement DB is opened.
    }
    try {
      await pool.importDb(DB_PATH, original);
      db = new pool.OpfsSAHPoolDb(DB_PATH);
    } catch (restoreError) {
      db = openScratch(original);
      pool = undefined;
      throw new Error(
        `Could not restore on-device storage; original data is available in this tab. Export a backup. ${String(restoreError)}`
      );
    }
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
  validateUnits({ ...d.custom_units, ...getCustomUnits() }, { ...d.settings, ...getSettings() });
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

let requests = Promise.resolve();
self.onmessage = (e: MessageEvent) => {
  requests = requests.then(() => handleMessage(e));
};

async function handleMessage(e: MessageEvent) {
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
        await replaceBytes(payload.bytes);
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
    (self as unknown as Worker).postMessage({ id, result, persistent: Boolean(pool) });
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id,
      persistent: Boolean(pool),
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
