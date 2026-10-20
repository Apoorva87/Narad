import { test, expect } from '@playwright/test';
import sharp from 'sharp';
import { minimalLesson } from './fixture';

test('a prepared source opens learning modes and remains linked from its original source view', async ({ page, request }) => {
  const bundle = await (await request.post('/api/source-bundles', { data: { title: 'Ready for tutoring', text: 'A captured article.' } })).json();
  const lesson = minimalLesson(); lesson.id = 'prepared-source-fixture'; lesson.title = 'Ready for tutoring'; lesson.sourceBundleId = bundle.id;
  lesson.modes.summary = { title: 'A brief summary', sections: [{ id: 'brief', title: 'The main idea', blocks: [{ id: 'brief-a', kind: 'text', markdown: 'Here is the brief teaching summary.', spokenText: 'Here is the brief teaching summary.', origin: 'teaching', references: [] }] }] };
  lesson.modes.dialogue = { title: 'A tutor conversation', sections: [{ id: 'conversation', title: 'Let’s discuss it', blocks: [{ id: 'conversation-a', kind: 'dialogue', speaker: 'Tutor', role: 'expert', markdown: 'Let’s reason through this together.', spokenText: 'Let’s reason through this together.', origin: 'teaching', references: [] }] }] };
  expect((await request.post('/api/lessons', { data: lesson })).ok()).toBe(true);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your learning library' })).toBeVisible();
  await expect(page.locator('.source-row').filter({ hasText: lesson.title })).toHaveCount(0);
  await page.locator('.lesson-row .library-row-main').filter({ hasText: lesson.title }).click();
  await expect(page.getByRole('tab', { name: 'Quick summary' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Here is the brief teaching summary.')).toBeVisible();
  await page.getByRole('tab', { name: 'Tutor dialogue' }).click();
  await expect(page.getByText('Let’s reason through this together.')).toBeVisible();
  await page.goto('/#sources/' + bundle.id);
  await page.getByRole('button', { name: 'Open learning modes' }).click();
  await expect(page).toHaveURL(new RegExp('#lesson/' + bundle.id + '$'));
});

test('saved sources appear in navigation and match searches without accents', async ({ page, request }) => {
  const response = await request.post('/api/source-bundles', { data: { title: 'Jalapeño architecture search fixture', text: 'An inference chip to study.' } });
  expect(response.ok()).toBe(true);
  const bundle = await response.json();
  await page.goto('/');
  await page.getByRole('searchbox', { name: 'Search lessons' }).fill('  jalapeno  ');
  const card = page.locator('.source-row .library-row-main').filter({ hasText: bundle.title });
  await expect(card).toBeVisible();
  await expect(page.locator('.empty-state')).toHaveCount(0);
  await expect(page.locator('.sidebar-sources').getByRole('button', { name: bundle.title })).toBeVisible();
  const lessons = await (await request.get('/api/lessons')).json();
  const sources = await (await request.get('/api/source-bundles')).json();
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).locator('.nav-count')).toHaveText(String(lessons.length + sources.filter((source: { lessonId?: string }) => !source.lessonId).length));
  await card.click();
  await expect(page).toHaveURL(new RegExp('#sources/' + bundle.id + '$'));
  await expect(page.getByRole('heading', { name: bundle.title, exact: true })).toBeVisible();
});

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
  await page.locator('.source-row .library-row-main').filter({ hasText: 'A chart to understand' }).click();
  await expect(page).toHaveURL(url);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
