// Layout interactions for the notepad shell: the two column splitters can be
// dragged to resize the adjacent columns, and their chevrons collapse/expand a
// column to/from zero width. State persists to the DB and survives reload.
//
// The chevrons live inside the splitter and are opacity-0 until hover, so we
// scope by position: the first .splitter sits between editor and gutter, the
// second between gutter and inspector.

import { expect, test, type Page } from '@playwright/test';

// Pack a sheet into the share-hash so a scenario loads deterministically
// (mirrors src/lib/share.ts encodeShare; same helper as the screenshot specs).
function shareHash(body: string): string {
	const json = JSON.stringify({ title: 'Demo', body, seed: 0x9e3779b9 });
	return Buffer.from(encodeURIComponent(json)).toString('base64');
}

async function boot(page: Page) {
	await page.goto('/');
	// Editor (CodeMirror) mounting signals the notepad shell is live.
	await page.locator('.cm-editor').first().waitFor({ state: 'visible' });
	// Both splitters present means we're in notepad mode with all columns shown.
	await expect(page.locator('.splitter')).toHaveCount(2);
}

function colWidth(page: Page, selector: string) {
	return page
		.locator(selector)
		.evaluate((el) => Math.round(el.getBoundingClientRect().width));
}

// Chevrons are hover-revealed (opacity 0 + pointer-events: none at rest) and
// only become interactive once their splitter is hovered — exactly as a real
// user reveals them before clicking. So hover the splitter first, then click
// the chevron. (A collapsed column's re-expand chevron stays visible, but
// hovering first is harmless there too.)
async function clickChevron(page: Page, splitterIndex: number, side: 'left' | 'right') {
	const splitter = page.locator('.splitter').nth(splitterIndex);
	await splitter.hover();
	await splitter.locator(`.chevron.${side}`).click();
}

// Layout settings are written to the OPFS-backed DB worker as a fire-and-forget
// async call. A reload fired too soon can outrun the SAH-pool write commit, so
// give the round-trip a beat to flush before navigating. (A real user never
// reloads within a few hundred ms of resizing; this is a test-only settle.)
async function flushPersistence(page: Page) {
	await page.waitForTimeout(500);
}

test.describe('column collapse via chevrons', () => {
	test('right chevron of the first splitter collapses and re-expands the gutter', async ({
		page
	}) => {
		await boot(page);
		const gutterBefore = await colWidth(page, '.gutter-col');
		expect(gutterBefore).toBeGreaterThan(0);

		// Collapse the gutter (right column of splitter 1).
		await clickChevron(page, 0, 'right');
		await expect(page.locator('.body')).toHaveClass(/gutter-collapsed/);
		expect(await colWidth(page, '.gutter-col')).toBe(0);

		// Re-expand it.
		await clickChevron(page, 0, 'right');
		await expect(page.locator('.body')).not.toHaveClass(/gutter-collapsed/);
		expect(await colWidth(page, '.gutter-col')).toBeGreaterThan(0);
	});

	test('left chevron of the first splitter collapses the editor', async ({ page }) => {
		await boot(page);
		expect(await colWidth(page, '.editor')).toBeGreaterThan(0);

		await clickChevron(page, 0, 'left');
		await expect(page.locator('.body')).toHaveClass(/editor-collapsed/);
		expect(await colWidth(page, '.editor')).toBe(0);
	});

	test('collapse state persists across reload', async ({ page }) => {
		await boot(page);
		await clickChevron(page, 0, 'right');
		await expect(page.locator('.body')).toHaveClass(/gutter-collapsed/);
		await flushPersistence(page);

		await page.reload();
		await page.locator('.cm-editor').first().waitFor({ state: 'visible' });
		await expect(page.locator('.body')).toHaveClass(/gutter-collapsed/);
		expect(await colWidth(page, '.gutter-col')).toBe(0);
	});
});

test.describe('draggable resize', () => {
	test('dragging the first splitter right widens the editor and narrows the gutter', async ({
		page
	}) => {
		await boot(page);
		const editorBefore = await colWidth(page, '.editor');
		const gutterBefore = await colWidth(page, '.gutter-col');

		const splitter = page.locator('.splitter').first();
		const box = (await splitter.boundingBox())!;
		const startX = box.x + box.width / 2;
		// Grab near the top of the splitter, clear of the vertically-centred
		// chevron buttons.
		const y = box.y + 12;
		const dx = 80;

		await page.mouse.move(startX, y);
		await page.mouse.down();
		await page.mouse.move(startX + dx, y, { steps: 10 });
		await page.mouse.up();

		const editorAfter = await colWidth(page, '.editor');
		const gutterAfter = await colWidth(page, '.gutter-col');

		expect(editorAfter).toBeGreaterThan(editorBefore + 40);
		expect(gutterAfter).toBeLessThan(gutterBefore - 40);
		// The drag conserves width between the two columns (inspector untouched).
		expect(editorAfter - editorBefore).toBeCloseTo(gutterBefore - gutterAfter, -1);
	});

	test('resized widths persist across reload', async ({ page }) => {
		await boot(page);
		const splitter = page.locator('.splitter').first();
		const box = (await splitter.boundingBox())!;
		const startX = box.x + box.width / 2;
		// Grab near the top of the splitter, clear of the vertically-centred
		// chevron buttons.
		const y = box.y + 12;

		await page.mouse.move(startX, y);
		await page.mouse.down();
		await page.mouse.move(startX + 80, y, { steps: 10 });
		await page.mouse.up();

		const editorAfter = await colWidth(page, '.editor');
		await flushPersistence(page);

		await page.reload();
		await page.locator('.cm-editor').first().waitFor({ state: 'visible' });
		// boot() applies the persisted layout a tick after the editor mounts, so
		// the column briefly shows its default width — poll until it settles to
		// the resized value rather than reading once and racing that hydration.
		await expect
			.poll(() => colWidth(page, '.editor'))
			.toBeGreaterThan(editorAfter - 10);
	});

	test('the splitter is keyboard-resizable via arrow keys', async ({ page }) => {
		await boot(page);
		const editorBefore = await colWidth(page, '.editor');

		const splitter = page.locator('.splitter').first();
		await splitter.focus();
		// ArrowRight widens the editor by 8px per press (32 with Shift).
		await splitter.press('ArrowRight');
		await splitter.press('Shift+ArrowRight');

		expect(await colWidth(page, '.editor')).toBe(editorBefore + 8 + 32);
	});
});

test.describe('onboarding: errors link to the cheat sheet', () => {
	test('an errored line offers "see examples" that opens help focused on the group', async ({
		page
	}) => {
		// A dimension mismatch maps to the "Units & conversion" cheat-sheet group.
		await page.goto(`/#${shareHash('5 km + 3 s')}`);
		await page.locator('.cm-editor').first().waitFor({ state: 'visible' });

		// Select the errored line so the inspector shows its detail.
		await page.locator('.gutter .row.err').first().click();

		const link = page.locator('.inspector .see-examples');
		await expect(link).toBeVisible();
		await expect(link).toContainText('Units & conversion');

		await link.click();

		// The cheat sheet opens with the relevant group flagged as focused.
		const focused = page.locator('.help section.focus');
		await expect(focused).toBeVisible();
		await expect(focused.locator('h4')).toHaveText('Units & conversion');
	});

	// Regression: an empty sheet (e.g. after "New sheet" or clearing all data)
	// shows the Notepad onboarding, so the gutter and results grid must NOT also
	// print their own "nothing here" hints — three redundant empty messages across
	// the panes read as a broken layout.
	test('an empty sheet shows only the onboarding, not the gutter/grid empty hints', async ({
		page
	}) => {
		await page.goto(`/#${shareHash('')}`);
		await page.locator('.cm-editor').first().waitFor({ state: 'visible' });

		await expect(page.getByText('Type math. Get answers.')).toBeVisible();
		await expect(page.getByText('Results appear here')).toHaveCount(0);
		await expect(page.getByText('no results yet')).toHaveCount(0);
	});

	// Contrast: a non-empty sheet that simply has no computable results (only a
	// comment) is NOT the onboarding state, so the gutter/grid hints still apply.
	test('a comment-only sheet still shows the gutter and grid empty hints', async ({ page }) => {
		await page.goto(`/#${shareHash('# just a note')}`);
		await page.locator('.cm-editor').first().waitFor({ state: 'visible' });

		await expect(page.getByText('Type math. Get answers.')).toHaveCount(0);
		await expect(page.getByText('Results appear here')).toBeVisible();
		await expect(page.getByText('no results yet')).toBeVisible();
	});

	// Regression: with its hint suppressed, the empty gutter has no content to
	// size it, so it must be stretched to fill its column. Otherwise it collapses
	// to a thin sliver and leaves a dead gap before the inspector.
	test('the empty gutter fills its column rather than collapsing', async ({ page }) => {
		await page.goto(`/#${shareHash('')}`);
		await page.locator('.cm-editor').first().waitFor({ state: 'visible' });
		await expect(page.locator('.pad .empty')).toBeVisible();

		const widths = await page.evaluate(() => {
			const w = (s: string) => {
				const el = document.querySelector(s) as HTMLElement | null;
				return el ? el.getBoundingClientRect().width : 0;
			};
			return { col: w('.gutter-col'), box: w('.gutter') };
		});
		expect(widths.col).toBeGreaterThan(100);
		expect(widths.box).toBeGreaterThan(widths.col - 2); // fills, not a sliver
	});

	// Regression: the onboarding overlay must clear CodeMirror's line-number
	// gutter so its text lines up with typed text instead of bleeding over the "1".
	test('the onboarding text clears the line-number gutter', async ({ page }) => {
		await page.goto(`/#${shareHash('')}`);
		await page.locator('.cm-editor').first().waitFor({ state: 'visible' });
		await expect(page.locator('.pad .empty')).toBeVisible();

		const edges = await page.evaluate(() => {
			const r = (s: string) => {
				const el = document.querySelector(s) as HTMLElement | null;
				return el ? el.getBoundingClientRect() : null;
			};
			return { gutterRight: r('.cm-gutters')?.right ?? 0, overlayLeft: r('.pad .empty')?.left ?? 0 };
		});
		expect(edges.overlayLeft).toBeGreaterThanOrEqual(edges.gutterRight);
	});
});
