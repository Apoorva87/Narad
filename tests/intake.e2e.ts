import { test, expect } from '@playwright/test';
import sharp from 'sharp';

test('add an idea with an image, review sources, and reopen from the library', async ({ page }) => {
  const errors: string[] = []; page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/');
  await page.getByRole('button', { name: 'Add a lesson', exact: true }).last().click();
  await page.getByLabel('Title (optional)').fill('A chart to understand');
  await page.getByLabel('Ideas, notes, or links').fill('Explain the relationship in my plot. Keep the value 3.14159.');
  const buffer = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#3456a8' } }).png().toBuffer();
  await page.getByLabel('Source images').setInputFiles({ name: 'my-chart.png', mimeType: 'image/png', buffer });
  await expect(page.getByText('my-chart.png', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save sources', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A chart to understand', exact: true })).toBeVisible();
  await expect(page.getByText(/Keep the value 3.14159/)).toBeVisible();
  await page.getByRole('button', { name: /my-chart.png/ }).click();
  await expect.poll(() => page.locator('.source-visual img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await page.getByRole('button', { name: 'Enlarge my-chart.png' }).click();
  await expect(page.getByRole('dialog').locator('img')).toBeVisible();
  await page.keyboard.press('Escape');
  const url = page.url(); await page.reload();
  await expect(page.getByRole('heading', { name: 'A chart to understand', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Your library', exact: false }).first().click();
  await page.locator('.source-card').filter({ hasText: 'A chart to understand' }).click();
  await expect(page).toHaveURL(url);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
