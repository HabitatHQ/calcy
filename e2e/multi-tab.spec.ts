// Regression for the OPFS SAH-pool multi-tab error: the access handles are
// exclusive per origin, so a second tab cannot open the database. It must
// degrade to an in-memory copy and warn the user — never throw an unhandled
// init error. Two pages in one context share the same origin (and OPFS).

import { expect, test } from '@playwright/test';

test('a second tab degrades to in-memory and warns instead of crashing', async ({ context }) => {
	const tab1 = await context.newPage();
	await tab1.goto('/');
	await tab1.locator('.cm-editor').first().waitFor({ state: 'visible' });

	const tab2 = await context.newPage();
	await tab2.goto('/');
	await tab2.locator('.cm-editor').first().waitFor({ state: 'visible' });

	// Exactly one tab owns OPFS; the other shows the ephemeral banner. Order is
	// whichever acquired the pool first, so assert on the total, not on a tab.
	await expect
		.poll(
			async () =>
				(await tab1.locator('.ephemeral-banner').count()) +
				(await tab2.locator('.ephemeral-banner').count()),
			{ timeout: 8000 }
		)
		.toBe(1);

	// The fallback must still evaluate user input, independently of whichever
	// starter sheet is bundled with the app.
	const degraded = (await tab1.locator('.ephemeral-banner').count()) ? tab1 : tab2;
	await degraded.locator('.cm-content').first().fill('rate = 3 req/s');
	await expect(degraded.locator('.gutter')).toContainText('3 req/s');
});
