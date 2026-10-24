// Data backup/restore + danger-zone flows, exercised through the real DB worker
// (migrations, JSON export/import merge, clear). Each test gets a fresh OPFS
// context, so destructive actions here only touch the test's own database.

import { expect, test, type Page } from '@playwright/test';
import * as fs from 'node:fs/promises';

function shareHash(body: string, title: string): string {
	const json = JSON.stringify({ title, body, seed: 0x9e3779b9 });
	return Buffer.from(encodeURIComponent(json)).toString('base64');
}

async function loadSheet(page: Page, body: string, title: string) {
	await page.goto(`/#${shareHash(body, title)}`);
	await page.locator('.cm-editor').first().waitFor({ state: 'visible' });
	await expect(page.locator('.cm-content').first()).toHaveText(body);
	await expect(page.getByRole('textbox', { name: 'sheet title' })).toHaveValue(title);
}

async function openSettings(page: Page) {
	await page.getByRole('button', { name: 'settings' }).click();
	// Settings is a floating panel (aria-label "settings"); wait for its title.
	await page.getByRole('heading', { name: 'Settings' }).waitFor({ state: 'visible' });
}

test('exports a versioned JSON backup containing the sheet', async ({ page }) => {
	await loadSheet(page, 'rent = 1800 $', 'Budget');
	await openSettings(page);

	const [download] = await Promise.all([
		page.waitForEvent('download'),
		page.getByRole('button', { name: 'Export JSON' }).click()
	]);
	const path = await download.path();
	const doc = JSON.parse(await fs.readFile(path, 'utf8'));

	expect(doc.version).toBe(1);
	expect(typeof doc.exported_at).toBe('string');
	expect(doc.sheets.some((s: { title: string; body: string }) => s.title === 'Budget' && s.body === 'rent = 1800 $')).toBe(true);
});

test('clearing all sheets then re-importing the backup restores them (merge)', async ({ page }) => {
	await loadSheet(page, 'rent = 1800 $', 'Budget');
	await openSettings(page);

	// Export the current sheet to a JSON file we can re-import.
	const [download] = await Promise.all([
		page.waitForEvent('download'),
		page.getByRole('button', { name: 'Export JSON' }).click()
	]);
	const backupPath = await download.path();

	// Clear all sheets (the confirm() dialog must be accepted).
	page.on('dialog', (d) => d.accept());
	await page.getByRole('button', { name: 'Clear', exact: true }).click();
	await expect(page.locator('.data-msg')).toContainText('cleared');

	// Settings now floats over a scrim that covers the header; close it before
	// reaching for the toolbar.
	await page.keyboard.press('Escape');

	// The Budget sheet is gone from the browser.
	await page.getByRole('button', { name: 'Sheets' }).click();
	await page.getByRole('menuitem', { name: 'Browse sheets' }).click();
	await expect(page.locator('.float')).toBeVisible();
	await expect(page.locator('.float')).not.toContainText('Budget');
	// Close the sheets browser, then reopen settings for the import.
	await page.keyboard.press('Escape');
	await openSettings(page);

	// Re-import the backup; the merge brings Budget back.
	await page.locator('input[type="file"][accept*="json"]').setInputFiles(backupPath);
	await expect(page.locator('.data-msg')).toContainText('Imported');

	// Dismiss settings (and its scrim) before using the toolbar again.
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'Sheets' }).click();
	await page.getByRole('menuitem', { name: 'Browse sheets' }).click();
	await expect(page.locator('.float')).toContainText('Budget');
});
