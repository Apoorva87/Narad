import { test, expect, type APIRequestContext } from '@playwright/test';
import { minimalLesson } from './fixture';

/** Shared samples keep reading positions for later test files; shortcut tests work on their own copy. */
async function copyOf(request: APIRequestContext, sample: string, id: string) {
  const lesson = await (await request.get('/api/lessons/' + sample)).json();
  expect((await request.post('/api/lessons', { data: { ...lesson, id, isSample: false, title: 'Copy for ' + id, description: 'A test copy.' } })).ok()).toBe(true);
  return id;
}

test('the library lists items newest first and renames and permanently deletes them', async ({ page, request }) => {
  const older = minimalLesson(); older.id = 'list-older'; older.title = 'Older list lesson'; older.createdAt = '2026-01-02T10:00:00.000Z';
  const newer = minimalLesson(); newer.id = 'list-newer'; newer.title = 'Newer list lesson'; newer.createdAt = '2026-09-02T10:00:00.000Z';
  for (const lesson of [older, newer]) expect((await request.post('/api/lessons', { data: lesson })).ok()).toBe(true);
  const bundle = await (await request.post('/api/source-bundles', { data: { title: 'List sources to remove', text: 'Notes only.' } })).json();
  await page.goto('/');
  await expect(page.locator('.library-row').filter({ hasText: 'Older list lesson' })).toBeVisible();
  const titles = await page.locator('.library-row .row-text strong').allTextContents();
  expect(titles.indexOf('List sources to remove')).toBeLessThan(titles.indexOf('Newer list lesson'));
  expect(titles.indexOf('Newer list lesson')).toBeLessThan(titles.indexOf('Older list lesson'));

  await page.getByRole('button', { name: 'Rename Older list lesson' }).click();
  await page.getByLabel('New title').fill('Renamed list lesson');
  await page.keyboard.press('Enter');
  await expect(page.locator('.lesson-row').filter({ hasText: 'Renamed list lesson' })).toBeVisible();
  await expect(page.locator('.sidebar-lessons').getByRole('button', { name: 'Renamed list lesson' })).toBeVisible();

  await page.getByRole('button', { name: 'Delete Renamed list lesson' }).click();
  await expect(page.getByRole('dialog')).toContainText('permanently removes');
  await page.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(page.locator('.library-row').filter({ hasText: 'Renamed list lesson' })).toHaveCount(0);
  expect((await request.get('/api/lessons/list-older')).status()).toBe(404);

  await page.getByRole('button', { name: 'Delete List sources to remove' }).click();
  await page.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(page.locator('.source-row').filter({ hasText: 'List sources to remove' })).toHaveCount(0);
  expect((await request.get('/api/source-bundles/' + bundle.id)).status()).toBe(404);
  await page.reload();
  await expect(page.locator('.library-row').filter({ hasText: 'Newer list lesson' })).toBeVisible();
});

test('the chosen level is saved with new sources and preselected for preparation', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add a lesson', exact: true }).last().click();
  await page.getByLabel('Ideas, notes, or links').fill('Explain attention in transformers.');
  await page.locator('.level-picker label').filter({ hasText: 'Advanced' }).click();
  await expect(page.getByRole('radio', { name: /Advanced/ })).toBeChecked();
  await page.getByRole('button', { name: 'Save sources', exact: true }).click();
  await expect(page.getByLabel('Learner level')).toHaveValue('advanced');
});

test('keyboard shortcuts move passages, switch modes and open help', async ({ page, request }) => {
  await page.goto('/#lesson/' + await copyOf(request, 'bayesian-reasoning', 'shortcut-copy'));
  await page.getByRole('tab', { name: 'Detailed walkthrough' }).click();
  await expect(page.locator('.reading-status strong')).toHaveText(/^Passage 1 of/);
  await page.keyboard.press('l');
  await expect(page.locator('.reading-status strong')).toHaveText(/^Passage 2 of/);
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.reading-status strong')).toHaveText(/^Passage 1 of/);
  await page.keyboard.press('1');
  await expect(page.getByRole('tab', { name: 'Quick summary' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Shift+?');
  await expect(page.getByRole('dialog', { name: 'Shortcuts' })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('presentation mode plays narration and holds the latest figure until the next one', async ({ page, request }) => {
  const id = await copyOf(request, 'gradient-descent', 'presentation-copy');
  await page.route('**/api/speech', route => route.fulfill({ json: { state: 'ready', model: 'Fixture' } }));
  await page.route('**/api/speech/render', route => route.fulfill({ status: 503, json: { error: 'Fixture speech unavailable.' } }));
  await page.goto('/#lesson/' + id);
  await page.getByRole('tab', { name: 'Detailed walkthrough' }).click();
  await page.getByRole('button', { name: 'Set reading position at g-step', exact: true }).click();
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  const stage = page.getByRole('dialog', { name: /^Presenting/ });
  await expect(stage).toBeVisible();
  await expect(stage.locator('.presentation-title-card')).toBeVisible(); // No figure yet before g-figure.
  await expect(stage.locator('.presentation-status')).toContainText('Fixture speech unavailable.');
  await stage.getByRole('button', { name: 'Next passage' }).click();
  await expect(stage.locator('.presentation-figure img')).toHaveAttribute('src', /\/api\/library\/[a-z0-9-]+\/media\/gradient-curve\.svg$/);
  await page.keyboard.press('ArrowRight');
  await expect(stage.locator('.presentation-transcript')).toContainText(/./);
  await expect(stage.locator('.presentation-figure img')).toHaveAttribute('src', /\/api\/library\/[a-z0-9-]+\/media\/gradient-curve\.svg$/);
  await expect.poll(() => stage.locator('.presentation-figure img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await page.keyboard.press('t');
  await expect(stage.locator('.presentation-transcript')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(stage).toHaveCount(0);
  await expect(page.locator('.active-block')).toHaveAttribute('id', 'block-g-factor');
});

test('lock screen controls show the spoken sentence and the current slide', async ({ page, request }) => {
  const id = await copyOf(request, 'gradient-descent', 'lock-screen-copy');
  const wav = (seconds: number) => { const length = Math.floor(seconds * 24000) * 2; const b = Buffer.alloc(44 + length); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(length, 40); return b; };
  await page.route('**/api/speech', route => route.fulfill({ json: { state: 'ready', model: 'Fixture' } }));
  await page.route('**/api/speech/render', route => route.fulfill({ contentType: 'audio/wav', body: wav(15) }));
  await page.goto('/#lesson/' + id);
  await page.getByRole('tab', { name: 'Detailed walkthrough' }).click();
  await page.getByRole('button', { name: 'Set reading position at g-factor', exact: true }).click();
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  const stage = page.getByRole('dialog', { name: /^Presenting/ });
  const metadata = () => page.evaluate(() => { const m = navigator.mediaSession.metadata; return m && { title: m.title, artist: m.artist, album: m.album, artwork: m.artwork.map(a => ({ src: a.src, type: a.type })) }; });
  const lesson = await (await request.get('/api/lessons/' + id)).json();
  const spoken: string = lesson.modes.walkthrough.sections.flatMap((s: { blocks: { id: string; spokenText: string }[] }) => s.blocks).find((b: { id: string }) => b.id === 'g-factor').spokenText;
  await expect.poll(async () => (await metadata())?.artwork[0]?.type).toBe('image/png');
  const value = (await metadata())!;
  expect(spoken.startsWith(value.title.slice(0, 40))).toBe(true);
  expect(value.album).toBe('Copy for lock-screen-copy');
  expect(value.artwork[0].src).toMatch(/^blob:/);
  // Before the first figure the artwork is the logo; returning to the figure passage restores the same slide.
  const figureArtwork = value.artwork[0].src;
  await stage.getByRole('button', { name: 'Previous passage' }).click();
  await stage.getByRole('button', { name: 'Previous passage' }).click();
  await expect.poll(async () => (await metadata())?.artwork[0]?.src).not.toBe(figureArtwork);
  await expect.poll(async () => (await metadata())?.artwork[0]?.type).toBe('image/png');
  await stage.getByRole('button', { name: 'Next passage' }).click();
  await expect.poll(async () => (await metadata())?.artwork[0]?.src).toBe(figureArtwork);
});

test('presentation starts from the floating player without scrolling back up', async ({ page, request }) => {
  const id = await copyOf(request, 'gradient-descent', 'player-present-copy');
  await page.route('**/api/speech', route => route.fulfill({ json: { state: 'ready', model: 'Fixture' } }));
  await page.route('**/api/speech/render', route => route.fulfill({ status: 503, json: { error: 'Fixture speech unavailable.' } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#lesson/' + id);
  await page.getByRole('tab', { name: 'Detailed walkthrough' }).click();
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }));
  await expect(page.getByRole('button', { name: 'Present', exact: true })).not.toBeInViewport();
  const player = page.locator('.reading-controls');
  await expect(player.getByRole('button', { name: 'Start presentation' })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await player.getByRole('button', { name: 'Start presentation' }).click();
  await expect(page.getByRole('dialog', { name: /^Presenting/ })).toBeVisible();
});
