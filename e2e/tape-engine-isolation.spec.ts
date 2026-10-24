import { expect, test } from '@playwright/test';

test('Tape evaluations leave the Notepad rate inspector snapshot intact', async ({ page }) => {
  await page.goto('/');
  const editor = page.locator('.cm-content').first();
  await editor.waitFor({ state: 'visible' });
  await editor.fill('rate = 1 $/day');
  const rateRow = page.locator('.grid-wrap tbody tr').filter({ hasText: '1 $/day' });
  await expect(rateRow).toBeVisible();
  await rateRow.click();
  const inspector = page.locator('.inspector');
  await expect(inspector.locator('.card')).toContainText('Accumulate over');
  await expect(inspector.locator('.total')).toContainText('$1.00');

  await page.getByRole('tab', { name: 'Tape' }).click();
  await expect(page.locator('.tape .value')).toContainText('req');
  await page.getByRole('tab', { name: 'Notepad' }).click();
  const count = inspector.getByRole('spinbutton', { name: 'count' });
  await count.fill('2');
  await expect(inspector.locator('.total')).toContainText('$2.00');
});
