// Full UI walkthrough capture — one full-viewport shot per major state, used
// for a manual UI review pass. Not a regression suite. Output: test-results/walkthrough/.
import { type Page, test } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { waitForAppRendered } from './capture';

const OUT = path.join('test-results', 'walkthrough');

function shareHash(body: string, opts: { title?: string; seed?: number } = {}): string {
	const json = JSON.stringify({ title: opts.title ?? 'Demo', body, seed: opts.seed ?? 0x9e3779b9 });
	return Buffer.from(encodeURIComponent(json)).toString('base64');
}
async function loadSheet(page: Page, body: string, opts?: { seed?: number; title?: string }) {
	await page.goto(`/#${shareHash(body, opts)}`);
	await waitForAppRendered(page);
}
async function freeze(page: Page) {
	await page.addStyleTag({
		content: `*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}`
	});
}
async function shot(page: Page, name: string) {
	await freeze(page);
	await fs.mkdir(OUT, { recursive: true });
	await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

const ESTIMATE = `# Project estimate — tasks in plain English
design  = two days to four days
backend = between 5 and 12 days
qa      = 3 ± 1 day
total   = sum(above) in days
chance(total < 20 days)         # odds of hitting the deadline`;

test.use({ viewport: { width: 1440, height: 900 } });

test.describe('UI walkthrough', () => {
	test('01 empty / templates gallery', async ({ page }) => {
		await loadSheet(page, '');
		await page.locator('.tpl').first().waitFor({ state: 'visible' });
		await shot(page, '01-empty-templates');
	});

	test('02 notepad — estimate (3 columns)', async ({ page }) => {
		await loadSheet(page, ESTIMATE);
		await page.locator('.gutter .row.dist').first().waitFor({ state: 'visible' });
		await shot(page, '02-notepad-estimate');
	});

	test('03 distribution panel (plain + stats)', async ({ page }) => {
		await loadSheet(page, ESTIMATE);
		await page.locator('.gutter .row.dist').first().waitFor({ state: 'visible' });
		await page.locator('.gutter .row.dist').last().click();
		await page.locator('.inspector .dist .plain').waitFor({ state: 'visible' });
		await shot(page, '03-inspector-dist');
		await page.locator('.inspector .dist details > summary').click();
		await page.locator('.inspector .dist details table').waitFor({ state: 'visible' });
		await shot(page, '03b-inspector-dist-stats');
	});

	test('04 tape mode', async ({ page }) => {
		await loadSheet(page, ESTIMATE);
		await page.locator('.gutter .row.dist').first().waitFor({ state: 'visible' });
		await page.getByRole('tab', { name: 'Tape' }).click();
		await page.waitForTimeout(300);
		await shot(page, '04-tape');
	});

	test('05 examples panel', async ({ page }) => {
		await loadSheet(page, '5 km + 3 mi');
		await page.getByRole('button', { name: 'Sheets' }).click();
		await page.getByRole('menuitem', { name: 'Start from an example' }).click();
		await page.locator('.float').first().waitFor({ state: 'visible' });
		await page.waitForTimeout(300);
		await shot(page, '05-examples');
	});

	test('06 sheets panel', async ({ page }) => {
		await loadSheet(page, ESTIMATE);
		await page.getByRole('button', { name: 'Sheets' }).click();
		await page.getByRole('menuitem', { name: 'Browse sheets' }).click();
		await page.waitForTimeout(300);
		await shot(page, '06-sheets');
	});

	test('07 history panel', async ({ page }) => {
		await loadSheet(page, ESTIMATE);
		await page.getByRole('button', { name: 'Sheets' }).click();
		await page.getByRole('menuitem', { name: 'Revision history' }).click();
		await page.waitForTimeout(300);
		await shot(page, '07-history');
	});

	test('08 settings panel', async ({ page }) => {
		await loadSheet(page, ESTIMATE);
		await page.locator('[aria-label="settings"]').click();
		await page.locator('.panel.settings').waitFor({ state: 'visible' });
		await shot(page, '08-settings');
	});

	test('09 help panel', async ({ page }) => {
		await loadSheet(page, 'about 5 days');
		await page.locator('[aria-label="help"]').click();
		await page.locator('.help').waitFor({ state: 'visible' });
		await shot(page, '09-help');
	});

	test('10 friendly error', async ({ page }) => {
		await loadSheet(page, '5 km + 3 s\n10 / 0\nsqrt(-1)');
		await page.locator('.gutter .row.err').first().waitFor({ state: 'visible' });
		await shot(page, '10-friendly-error');
	});

	test('11 inspector — unit conversion', async ({ page }) => {
		await loadSheet(page, '120 km/h\n5 km + 3 mi\n2 GB / 30 s');
		await page.locator('.gutter .row').first().waitFor({ state: 'visible' });
		await page.locator('.gutter .row').first().click();
		await page.waitForTimeout(300);
		await shot(page, '11-inspector-convert');
	});

	test('13 degenerate distribution summary', async ({ page }) => {
		await loadSheet(page, 'x = 1 to 10\nx - x');
		await page.locator('.gutter .row.dist').first().waitFor({ state: 'visible' });
		await page.locator('.gutter .row.dist').last().click();
		await page.locator('.inspector .dist .plain').waitFor({ state: 'visible' });
		await shot(page, '13-degenerate-dist');
	});

	test('12 narrow viewport', async ({ page }) => {
		await page.setViewportSize({ width: 760, height: 900 });
		await loadSheet(page, ESTIMATE);
		await page.locator('.cm-content').waitFor({ state: 'visible' });
		await page.waitForTimeout(500);
		await shot(page, '12-narrow');
	});
});
