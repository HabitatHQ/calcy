import { Buffer } from 'node:buffer';
import { expect, test } from '@playwright/test';

// Every test gets Playwright's fresh browser context, so this only touches its
// isolated OPFS database and never the user's real storage.
test('a rejected SQLite import preserves the open database and permits later saves', async ({ page }) => {
  await page.goto('/');
  const editor = page.locator('.cm-content').first();
  await editor.waitFor({ state: 'visible' });
  await editor.fill('recovery_marker = 731');
  await expect(page.locator('.gutter')).toContainText('731');
  await page.getByRole('textbox', { name: 'sheet title' }).fill('Before failed import');
  await page.waitForTimeout(900);

  await page.getByRole('button', { name: 'settings' }).click();
  const input = page.locator('input[accept=".sqlite"]');
  await input.setInputFiles({
    name: 'short.sqlite',
    mimeType: 'application/x-sqlite3',
    buffer: Buffer.alloc(20)
  });
  const shortImportError = await page.locator('.data-msg.err').textContent();
  const malformed = new Uint8Array(512);
  malformed.set(new TextEncoder().encode('SQLite format 3\0'));
  await input.setInputFiles({
    name: 'malformed.sqlite',
    mimeType: 'application/x-sqlite3',
    buffer: Buffer.from(malformed)
  });
  await expect(page.locator('.data-msg.err')).not.toHaveText(shortImportError ?? '');
  await expect(page.locator('.data-msg.err')).toContainText('Could not import that database');
  await page.getByRole('button', { name: 'close settings' }).click();

  await editor.fill('recovery_marker = 947');
  await expect(page.locator('.gutter')).toContainText('947');
  await page.waitForTimeout(900);
  await page.reload();
  await expect(page.locator('.cm-content').first()).toContainText('recovery_marker = 947');
  await expect(page.getByRole('textbox', { name: 'sheet title' })).toHaveValue('Before failed import');
});
