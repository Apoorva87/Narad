import { test, expect } from '@playwright/test';

test('help navigation opens the architecture guide and survives reload', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Help & architecture' }).click();

  await expect(page).toHaveURL(/#help$/);
  await expect(page.getByRole('heading', { name: 'How Narad turns sources into understanding' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Narad system architecture' })).toContainText('Codex or Claude');
  await expect(page.getByRole('img', { name: 'Narad system architecture' })).toContainText('Local speech worker');
  await expect(page.getByText('Generated speech is streamed to the browser and is not saved as WAV files.')).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'How Narad turns sources into understanding' })).toBeVisible();
});

test('help architecture follows the mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#help');

  await expect(page.getByRole('heading', { name: 'How Narad turns sources into understanding' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
