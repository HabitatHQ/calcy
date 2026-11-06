import { Buffer } from 'node:buffer';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Inject failures at the actual browser filesystem boundary, retaining the real
// SQLite, engine and worker protocols for the recovery assertions.
async function failStorageWrites(page: Page, command: 'import' | 'setCustomUnit') {
  await page.addInitScript((command) => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        if (!String(url).includes('/db/worker.ts')) {
          super(url, options);
          return;
        }
        const source = `
          let failWrites = false;
          const write = FileSystemSyncAccessHandle.prototype.write;
          FileSystemSyncAccessHandle.prototype.write = function(...args) {
            if (failWrites) throw new Error('injected storage write failure');
            return write.apply(this, args);
          };
          const queued = [];
          globalThis.onmessage = event => queued.push(event);
          // Vite supplies the worker URL at runtime; install the fault before loading it.
          await import(${JSON.stringify(String(url))});
          const handle = globalThis.onmessage;
          globalThis.onmessage = event => {
            if (event.data.type === ${JSON.stringify(command)}) failWrites = true;
            handle(event);
          };
          for (const event of queued) globalThis.onmessage(event);
        `;
        super(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })), options);
      }
    } as typeof Worker;
  }, command);
}

async function databaseFixture(units: Record<string, string> = {}, unrelated = false, malformed = false): Promise<Buffer> {
  const sqlite = await sqlite3InitModule();
  const db = new sqlite.oo1.DB(':memory:', 'c');
  try {
    if (unrelated) db.exec('CREATE TABLE unrelated (value TEXT)');
    else {
      db.exec(`
        PRAGMA user_version = 1;
        CREATE TABLE sheet (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, seed INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE sheet_revision (id INTEGER PRIMARY KEY, sheet_id TEXT NOT NULL, body TEXT NOT NULL, saved_at INTEGER NOT NULL);
        CREATE TABLE custom_unit (name TEXT PRIMARY KEY, definition TEXT NOT NULL);
        CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `);
      for (const [name, definition] of Object.entries(units)) db.exec({ sql: 'INSERT INTO custom_unit VALUES (?, ?)', bind: [name, definition] });
      if (malformed) db.exec(`INSERT INTO sheet VALUES ('invalid', 'Invalid', '1', 'not a seed', 1, 1)`);
    }
    const pointer = db.pointer;
    if (pointer == null) throw new Error('fixture database is closed');
    return Buffer.from(sqlite.capi.sqlite3_js_db_export(pointer));
  } finally {
    db.close();
  }
}

test('pinning preserves an interval and converts a where result on the actual surface', async ({ page }) => {
  await page.goto('/');
  const editor = page.locator('.cm-content').first();
  await editor.fill('latency = 20 ms to 80 ms');
  const pin = page.getByRole('textbox', { name: 'convert selected line to unit' });
  await pin.fill('s');
  await pin.press('Enter');
  await expect(editor).toHaveText('latency = 20 ms to 80 ms in s');
  await expect(page.locator('.gutter')).toContainText(') s');
  const displayed = await page.locator('.gutter').innerText();
  const bounds = displayed.match(/\(([\d.]+) … ([\d.]+)\) s/);
  expect(Number(bounds?.[1])).toBeCloseTo(0.02, 2);
  expect(Number(bounds?.[2])).toBeCloseTo(0.08, 2);
  await editor.fill('d / t where d = 100 km, t = 2 h');
  await expect(page.locator('.gutter')).toContainText('50');
  await pin.fill('mph');
  await pin.press('Enter');
  await expect(page.locator('.gutter')).toContainText('31.1 mph');
});

test('invalid calendar edits retain the last valid live and persisted values', async ({ page }) => {
  await page.goto('/');
  await page.locator('.cm-content').first().fill('1 month in day');
  await expect(page.locator('.gutter')).toContainText('30.4');
  await page.getByRole('button', { name: 'settings', exact: true }).click();
  await page.locator('.advanced summary').click();
  const month = page.getByRole('spinbutton', { name: 'month d', exact: true });
  await month.fill('28');
  await month.press('Tab');
  await expect(page.locator('.gutter')).toContainText('28 day');
  for (const invalid of ['', '0', '-5']) {
    await month.fill(invalid);
    await month.press('Tab');
    await expect(month).toHaveValue('28');
    await expect(page.locator('.gutter')).toContainText('28 day');
  }
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  await downloaded;
  await page.reload();
  await expect(page.locator('.gutter')).toContainText('28 day');
});

test('custom-unit validation rejects unusable names and dependency-breaking deletion', async ({ page }) => {
  await page.goto('/');
  await page.locator('.cm-content').first().fill('1 + 1');
  await expect(page.locator('.gutter')).toContainText('2');
  await page.getByRole('button', { name: 'settings', exact: true }).click();
  await page.locator('.advanced summary').click();
  const unit = page.getByPlaceholder('sprint = 2 week');
  await unit.fill('in = 2 m');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('.unit-err')).toContainText('invalid');
  for (const definition of ['first_unit = 2 m', 'second_unit = 3 first_unit']) {
    await unit.fill(definition);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(unit).toHaveValue('');
  }
  await page.getByRole('button', { name: 'remove first_unit', exact: true }).click();
  await expect(page.locator('.unit-err')).toContainText('Cannot remove');
  await expect(page.getByRole('button', { name: 'remove first_unit', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'close settings' }).click();
  await page.locator('.cm-content').first().fill('1 second_unit in m');
  await expect(page.locator('.gutter')).toContainText('6 m');
});

test('SQLite candidates are checked before replacement and an empty restore adopts a fresh sheet', async ({ page }) => {
  await page.goto('/');
  const editor = page.locator('.cm-content').first();
  await editor.fill('preserved_marker = 947');
  await expect(page.locator('.gutter')).toContainText('947');
  await page.getByRole('textbox', { name: 'sheet title' }).fill('Preserved');
  await page.getByRole('button', { name: 'settings', exact: true }).click();
  const input = page.locator('input[accept=".sqlite"]');
  for (const bytes of [await databaseFixture({}, true), await databaseFixture({ broken: '???' }), await databaseFixture({}, false, true)]) {
    await input.setInputFiles({ name: 'candidate.sqlite', mimeType: 'application/x-sqlite3', buffer: bytes });
    await expect(page.locator('.data-msg.err')).toContainText('Could not import that database');
    await expect(editor).toHaveText('preserved_marker = 947');
    await expect(page.getByRole('textbox', { name: 'sheet title' })).toHaveValue('Preserved');
  }
  await input.setInputFiles({ name: 'empty.sqlite', mimeType: 'application/x-sqlite3', buffer: await databaseFixture() });
  await expect(page.getByRole('textbox', { name: 'sheet title' })).toHaveValue('Untitled');
  await expect(editor).toBeEmpty();
  await page.getByRole('button', { name: 'close settings' }).click();
  await editor.fill('after_restore = 731');
  await expect(page.locator('.gutter')).toContainText('731');
  await page.waitForTimeout(900);
  await page.reload();
  await expect(page.locator('.cm-content').first()).toHaveText('after_restore = 731');
});

test('a rejected JSON merge cannot persist broken custom units or partial sheet rows', async ({ page }) => {
  await page.goto('/');
  await page.locator('.cm-content').first().fill('1 + 1');
  await expect(page.locator('.gutter')).toContainText('2');
  await page.getByRole('button', { name: 'settings', exact: true }).click();
  const invalid = { version: 1, sheets: [{ id: 'must-not-merge', title: 'Rejected row', body: '1', seed: 1, created_at: 1, updated_at: 1 }], custom_units: { broken: '???' }, settings: {} };
  await page.locator('input[accept=".json,application/json"]').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalid)) });
  await expect(page.locator('.data-msg.err')).toContainText('custom unit');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const backup = JSON.parse(Buffer.concat(chunks).toString());
  expect(backup.custom_units).not.toHaveProperty('broken');
  expect(backup.sheets.some((sheet: { id: string }) => sheet.id === 'must-not-merge')).toBe(false);
});

test('an older real worker result cannot replace a newer document evaluation', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      set onmessage(callback: ((event: MessageEvent) => void) | null) {
        super.onmessage = callback && ((event: MessageEvent) => {
          const source = event.data.result?.lines?.[0]?.raw;
          if (source === 'older_marker = 111') setTimeout(() => callback(event), 600);
          else callback(event);
        });
      }
    } as typeof Worker;
  });
  await page.goto('/');
  const editor = page.locator('.cm-content').first();
  await editor.fill('older_marker = 111');
  await page.waitForTimeout(250);
  await editor.fill('newer_marker = 222');
  await expect(page.locator('.gutter')).toContainText('222');
  await page.waitForTimeout(700);
  await expect(editor).toHaveText('newer_marker = 222');
  await expect(page.locator('.gutter')).toContainText('222');
  await expect(page.locator('.gutter')).not.toContainText('111');
});

test('deleting the active sheet cancels its pending autosave', async ({ page }) => {
  await page.goto('/');
  const editor = page.locator('.cm-content').first();
  await editor.fill('delete_marker = 731');
  await expect(page.locator('.gutter')).toContainText('731');
  await page.getByRole('textbox', { name: 'sheet title' }).fill('Delete pending');
  await page.getByRole('button', { name: 'settings', exact: true }).click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  await downloaded;
  await page.getByRole('button', { name: 'close settings' }).click();
  const now = new Date('2026-01-01T00:00:00Z');
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  await editor.fill('delete_marker = 947');
  await page.getByRole('button', { name: 'Sheets', exact: true }).click();
  await page.getByRole('menuitem', { name: /Browse sheets/ }).click();
  page.on('dialog', (dialog) => dialog.accept());
  await page.locator('li.current').getByRole('button', { name: 'delete sheet', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'sheet title' })).toHaveValue('Untitled');
  await page.clock.runFor(1500);
  await page.reload();
  await page.getByRole('button', { name: 'Sheets', exact: true }).click();
  await page.getByRole('menuitem', { name: /Browse sheets/ }).click();
  await expect(page.locator('li').filter({ hasText: 'Delete pending' })).toHaveCount(0);
  await expect(page.locator('.cm-content').first()).not.toContainText('delete_marker');
});

test('a failed custom-unit disk write leaves the active rate engine intact', async ({ page }) => {
  await failStorageWrites(page, 'setCustomUnit');
  await page.goto('/');
  await page.locator('.cm-content').first().fill('rate = 1 $/day');
  await expect(page.locator('.inspector .total')).toContainText('$1.00');
  await page.getByRole('button', { name: 'settings', exact: true }).click();
  await page.locator('.advanced summary').click();
  await page.getByPlaceholder('sprint = 2 week').fill('stride = 2 m');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('.unit-err')).toContainText('invalid');
  await page.getByRole('button', { name: 'close settings' }).click();
  await page.locator('.inspector').getByRole('spinbutton', { name: 'count', exact: true }).fill('2');
  await expect(page.locator('.inspector .total')).toContainText('$2.00');
});

test('disk replacement and rollback failure retain recoverable data and a persistent warning', async ({ page }) => {
  await failStorageWrites(page, 'import');
  await page.goto('/');
  await page.locator('.cm-content').first().fill('recovery_marker = 947');
  await expect(page.locator('.gutter')).toContainText('947');
  await page.getByRole('button', { name: 'settings', exact: true }).click();
  await page.locator('input[accept=\".sqlite\"]').setInputFiles({
    name: 'empty.sqlite', mimeType: 'application/x-sqlite3', buffer: await databaseFixture()
  });
  await expect(page.locator('.ephemeral-banner')).toContainText('won’t be saved');
  await expect(page.locator('.data-msg.err')).toContainText('original data is available');
  await page.getByRole('button', { name: 'close settings' }).click();
  await page.locator('.cm-content').first().fill('recovery_marker = 731');
  await expect(page.locator('.gutter')).toContainText('731');
  await page.getByRole('button', { name: 'settings', exact: true }).click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const stream = await (await downloaded).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const backup = JSON.parse(Buffer.concat(chunks).toString());
  expect(backup.sheets.some((sheet: { body: string }) => sheet.body === 'recovery_marker = 731')).toBe(true);
  await expect(page.locator('.ephemeral-banner')).toBeVisible();
});
