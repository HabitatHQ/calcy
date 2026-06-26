// Screenshot capture for calcy's UI states.
//
// calcy is a single-route app, so instead of a route list (as in web-v2) each
// "scenario" loads a sheet via the share-hash (`/#<base64>`), waits for the
// worker eval to land, drives any UI affordance, and shoots. Output lands in
// test-results/screenshots/. Run with: `pnpm test:screenshots`.
//
// These specs are a capture tool, not visual-regression assertions: they fail
// when the app crashes or a shot comes out empty, not when pixels move.

import { expect, type Page, test } from '@playwright/test';
import { capture, expectScreenshotWritten, waitForAppRendered } from './capture';

// Mirror src/lib/share.ts encodeShare: JSON → encodeURIComponent → base64.
function shareHash(body: string, opts: { title?: string; seed?: number } = {}): string {
	const json = JSON.stringify({
		title: opts.title ?? 'Demo',
		body,
		seed: opts.seed ?? 0x9e3779b9
	});
	return Buffer.from(encodeURIComponent(json)).toString('base64');
}

async function loadSheet(page: Page, body: string, opts?: { seed?: number }): Promise<void> {
	await page.goto(`/#${shareHash(body, opts)}`);
	await waitForAppRendered(page);
}

const ESTIMATE = `# project estimate, in plain English
design = two days to four days
backend = between 5 and 12 days
qa = 3 ± 1 day
total = sum(above)
chance(total < 20 day)`;

test.describe('calcy screenshots', () => {
	test('notepad — plain-English input & distribution results', async ({ page }) => {
		await loadSheet(page, ESTIMATE);
		// Wait until at least one distribution row has been computed.
		await page.locator('.gutter .row.dist').first().waitFor({ state: 'visible' });
		// Regression: a hash-loaded sheet must reach the editor, not just results.
		await expect(page.locator('.cm-content')).toContainText('two days to four days');
		const shot = await capture(page, 'notepad-plain-english', { clip: '.pad' });
		await expectScreenshotWritten(shot.filePath);
	});

	test('distribution panel — plain-language summary', async ({ page }) => {
		await loadSheet(page, ESTIMATE);
		// Wait for the full eval (4 dist rows) so the row list is stable, then
		// select the rolled-up `total` line — the last distribution row.
		await expect(page.locator('.gutter .row.dist')).toHaveCount(4);
		await page.locator('.gutter .row.dist').last().click();
		const panel = page.locator('.inspector .dist');
		await panel.locator('.plain').waitFor({ state: 'visible' });
		const collapsed = await capture(page, 'distribution-panel-plain', { clip: panel });
		await expectScreenshotWritten(collapsed.filePath);

		// Expand the "All statistics" disclosure for the power-user view.
		await panel.locator('details > summary').click();
		await panel.locator('details table').waitFor({ state: 'visible' });
		const expanded = await capture(page, 'distribution-panel-stats', { clip: panel });
		await expectScreenshotWritten(expanded.filePath);
	});

	test('friendly error — plain hint in the gutter', async ({ page }) => {
		await loadSheet(page, '5 km + 3 s');
		await page.locator('.gutter .row.err').first().waitFor({ state: 'visible' });
		await expect(page.locator('.gutter .row.err')).toContainText(/can't add/i);
		const shot = await capture(page, 'friendly-error', { clip: '.pad' });
		await expectScreenshotWritten(shot.filePath);
	});

	test('help — Plain-English cheat-sheet group', async ({ page }) => {
		await loadSheet(page, 'about 5 days');
		await page.locator('[aria-label="help"]').click();
		await page.locator('.help').waitFor({ state: 'visible' });
		// Bring the new group into view within the scrollable panel.
		await page.locator('.help').getByText('Plain English').scrollIntoViewIfNeeded();
		const shot = await capture(page, 'help-plain-english', { clip: '.help' });
		await expectScreenshotWritten(shot.filePath);
	});

	test('templates — starter gallery on an empty sheet', async ({ page }) => {
		await loadSheet(page, '');
		await page.locator('.tpl').first().waitFor({ state: 'visible' });
		await expect(page.locator('.tpl')).toHaveCount(9);
		const shot = await capture(page, 'templates-gallery', { clip: '.pad' });
		await expectScreenshotWritten(shot.filePath);
		// clicking a template loads it into the editor
		await page.locator('.tpl', { hasText: 'Project estimate' }).click();
		await expect(page.locator('.cm-content')).toContainText('two days to four days');
	});

	test('templates — toolbar panel', async ({ page }) => {
		await loadSheet(page, '5 km + 3 mi'); // a non-empty sheet
		await page.getByRole('button', { name: 'Sheets' }).click();
		await page.getByRole('menuitem', { name: 'Start from an example' }).click();
		// The toolbar Examples panel is a FloatingPanel (.float); its entries are
		// EntryList buttons (.open).
		await expect(page.locator('.float .open')).toHaveCount(9);
		const shot = await capture(page, 'templates-panel', { clip: '.float' });
		await expectScreenshotWritten(shot.filePath);
		// picking one from a non-empty sheet starts a fresh sheet (no clobber)
		await page.locator('.float .open', { hasText: 'Fermi estimate' }).click();
		await expect(page.locator('.cm-content')).toContainText('piano tuners');
	});

	test('newspaper number format', async ({ page }) => {
		await loadSheet(page, 'rate = 50000 req/s\nrate * 1 year');
		await page.locator('.gutter .row').first().waitFor({ state: 'visible' });
		// Open settings, pick the spelled-out style, close settings. Scope to the
		// button: the open panel is a <section aria-label="settings"> too, so a bare
		// [aria-label="settings"] would match two elements.
		await page.getByRole('button', { name: 'settings' }).click();
		await page.getByRole('group', { name: 'number format' }).getByText('1 million').click();
		await page.getByRole('button', { name: 'settings' }).click();
		// The accumulated total is ~1.58e12 req → "1.58 trillion req".
		await expect(page.locator('.gutter')).toContainText(/trillion/i);
		const shot = await capture(page, 'newspaper-format', { clip: '.pad' });
		await expectScreenshotWritten(shot.filePath);
	});
});
