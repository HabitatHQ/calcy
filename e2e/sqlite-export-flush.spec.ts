import { Buffer } from 'node:buffer';
import { expect, test } from '@playwright/test';

test('SQLite export includes pending title and body edits in the downloadable database', async ({ page }) => {
  await page.goto('/');
  const editor = page.locator('.cm-content').first();
  await editor.waitFor({ state: 'visible' });
  const now = new Date('2026-01-01T00:00:00Z');
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  await editor.fill('export_marker = 731');
  await page.getByRole('textbox', { name: 'sheet title' }).fill('Latest export title');
  await page.getByRole('button', { name: 'settings' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export .sqlite' }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const all = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }

  // Change the live document so the assertions prove a database restore, not
  // merely that the editor still contains its pre-import text.
  await page.getByRole('button', { name: 'close settings' }).click();
  await editor.fill('different_marker = 123');
  await page.getByRole('textbox', { name: 'sheet title' }).fill('Not the backup');
  await page.getByRole('button', { name: 'settings' }).click();
  await page.locator('input[accept=".sqlite"]').setInputFiles({
    name: 'exported.sqlite',
    mimeType: 'application/x-sqlite3',
    buffer: Buffer.from(all)
  });
  await expect(page.getByRole('textbox', { name: 'sheet title' })).toHaveValue('Latest export title');
  await expect(page.locator('.cm-content').first()).toContainText('export_marker = 731');
});
