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

function mediaLesson(id: string) {
  const lesson = minimalLesson(); lesson.id = id; lesson.title = 'Media lesson ' + id;
  const credit = { pageTitle: 'The Source Page', pageUrl: 'https://example.com/page', mediaUrl: 'https://example.com/pic.png', creditLine: 'Figure by A. Author', license: 'https://creativecommons.org/licenses/by/4.0/', capturedAt: '2026-10-19T12:00:00.000Z' };
  lesson.assets = [
    { id: 'pic', src: '/assets/bayes-tree.svg', alt: 'A tree', caption: 'A captioned tree', provenance: 'source', kind: 'image', credit },
    { id: 'clip', src: '/assets/video-poster.svg', alt: 'A clip', caption: 'A short clip', provenance: 'source', kind: 'video', video: { provider: 'youtube', url: 'https://www.youtube.com/watch?v=abc123', embedUrl: 'https://www.youtube-nocookie.com/embed/abc123' } },
    { id: 'hostile', src: '/assets/bayes-tree.svg', alt: 'Odd', caption: 'Odd credit', provenance: 'source', kind: 'image', credit: { ...credit, pageTitle: 'Hostile Page', pageUrl: 'javascript:alert(1)', mediaUrl: 'javascript:alert(2)', license: 'javascript:alert(3)' } },
  ];
  const refs = [{ sourceId: 'source-1', locator: 'section-1' }];
  lesson.modes.walkthrough.sections[0].blocks.push(
    { id: 'fig-a', kind: 'figure', assetId: 'pic', markdown: 'A figure.', spokenText: 'A figure.', references: refs, origin: 'source' },
    { id: 'fig-b', kind: 'figure', assetId: 'clip', markdown: 'A clip.', spokenText: 'A clip.', references: refs, origin: 'source' },
    { id: 'fig-c', kind: 'figure', assetId: 'hostile', markdown: 'Odd.', spokenText: 'Odd.', references: refs, origin: 'source' });
  return lesson;
}

test('figures show their credit line and the Sources dialog lists every credit', async ({ page, request }) => {
  expect((await request.post('/api/lessons', { data: mediaLesson('credit-lesson') })).ok()).toBe(true);
  await page.goto('/#lesson/credit-lesson');
  const credit = page.locator('figure .credit-line').first();
  await expect(credit).toContainText('From The Source Page');
  await expect(credit.getByRole('link', { name: 'The Source Page' })).toHaveAttribute('href', 'https://example.com/page');
  await expect(credit.getByRole('link', { name: /original/ })).toHaveAttribute('href', 'https://example.com/pic.png');
  await expect(credit).toContainText('Figure by A. Author');
  await page.getByRole('button', { name: /1 source/ }).click();
  await expect(page.getByRole('dialog').locator('.credit-list')).toContainText('From The Source Page');
});

test('a video streams from its source and starting it pauses narration', async ({ page, request }) => {
  expect((await request.post('/api/lessons', { data: mediaLesson('video-lesson') })).ok()).toBe(true);
  await page.addInitScript(() => { const Original = window.Audio; (window as any).__audio = []; window.Audio = class extends Original { constructor(src?: string) { super(src); (window as any).__audio.push(this); } }; });
  const length = 24000 * 2 * 15; const wav = Buffer.alloc(44 + length); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(length, 40);
  await page.route('**/api/speech', route => route.fulfill({ json: { state: 'ready', model: 'Fixture' } }));
  await page.route('**/api/speech/render', route => route.fulfill({ contentType: 'audio/wav', body: wav }));
  await page.route('https://www.youtube-nocookie.com/**', route => route.fulfill({ contentType: 'text/html', body: '<button style="width:100%;height:100vh">player</button>' }));
  await page.goto('/#lesson/video-lesson');
  const frame = page.locator('iframe[src^="https://www.youtube-nocookie.com/embed/abc123"]');
  await expect(frame).toHaveAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  await expect(frame).toHaveAttribute('allow', 'encrypted-media; picture-in-picture; fullscreen');
  await expect(page.getByRole('link', { name: /Watch at the source/ }).first()).toHaveAttribute('href', 'https://www.youtube.com/watch?v=abc123');
  await page.getByRole('button', { name: 'Play narration', exact: true }).click();
  await expect(page.locator('.speech-state')).toContainText('Speaking');
  await frame.scrollIntoViewIfNeeded();
  await frame.click();
  await expect(page.getByRole('button', { name: 'Play narration', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__audio.at(-1).paused)).toBe(true);
});

test('credit links only use http and https addresses', async ({ page, request }) => {
  const lesson = mediaLesson('credit-safe');
  expect((await request.post('/api/lessons', { data: lesson })).ok()).toBe(true);
  await page.goto('/#lesson/credit-safe');
  const unsafe = page.locator('figure .credit-line').filter({ hasText: 'Hostile Page' });
  await expect(unsafe).toContainText('javascript:alert(3)');
  await expect(unsafe.locator('a')).toHaveCount(0);
});

test('a broken library item shows why it cannot be opened', async ({ page }) => {
  await page.route('**/api/lessons', async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    const list = await (await route.fetch()).json();
    await route.fulfill({ json: [...list, { id: 'broken-one', title: 'Broken one', description: '', topic: '', createdAt: '2026-10-19T12:00:00.000Z', isSample: false, familiarity: 'foundational', availableModes: [], sourceCount: 0, blockCount: 0, broken: 'lesson.json is not valid JSON' }] });
  });
  await page.goto('/');
  const row = page.locator('.library-row').filter({ hasText: 'Broken one' });
  await expect(row).toContainText('lesson.json is not valid JSON');
  await expect(row.locator('.library-row-main')).toBeDisabled();
});

test('an old lesson link lands on the lesson address without a new history entry', async ({ page, request }) => {
  const lesson = minimalLesson(); lesson.id = 'new-slug-lesson'; lesson.title = 'Slugged lesson';
  expect((await request.post('/api/lessons', { data: lesson })).ok()).toBe(true);
  await page.route('**/api/lessons/old-legacy-id', route => route.fulfill({ json: lesson }));
  await page.goto('/');
  const before = await page.evaluate(() => history.length);
  await page.evaluate(() => { location.hash = 'lesson/old-legacy-id'; });
  await expect(page.locator('.reader-heading h1')).toContainText('Slugged lesson');
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#lesson/new-slug-lesson');
  expect(await page.evaluate(() => history.length)).toBe(before + 1);
});

test('the preparation panel lists sections and continues, restarts and reveals the folder', async ({ page, request }) => {
  const bundle = await (await request.post('/api/source-bundles', { data: { title: 'Resumable sources', text: 'Notes only.', familiarity: 'foundational' } })).json();
  const job = { id: bundle.id, bundleId: bundle.id, slug: bundle.id, title: bundle.title, provider: 'codex', status: 'interrupted', stage: 'Interrupted when the server stopped', completed: 1, total: 2, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), folder: '/tmp/narad-library/' + bundle.id, error: 'Preparation was interrupted when the server stopped.',
    sections: [{ task: 'summary-1', title: 'Opening idea', state: 'done', durationMs: 65000 }, { task: 'summary-2', title: 'Second idea', state: 'failed', error: 'Agent timed out' }] };
  await page.route('**/api/preparation', route => route.fulfill({ json: { jobs: [job], sessions: [], providers: [{ id: 'codex', available: true }, { id: 'claude', available: true }] } }));
  const posts: any[] = [];
  await page.route('**/api/source-bundles/*/prepare', async route => { posts.push(route.request().postDataJSON()); await route.fulfill({ status: 202, json: job }); });
  let revealed = '';
  await page.route('**/api/library/*/reveal', async route => { revealed = route.request().url(); await route.fulfill({ status: 204 }); });
  await page.goto('/#sources/' + bundle.id);
  const panel = page.getByRole('region', { name: 'Lesson preparation' });
  await expect(panel.locator('.section-list li')).toHaveCount(2);
  await expect(panel.locator('.section-list li').first()).toContainText('Opening idea');
  await expect(panel.locator('.section-list li').first()).toContainText('1m 5s');
  await expect(panel.locator('.section-list li').nth(1)).toContainText('Agent timed out');
  await expect(panel.locator('.folder-path')).toHaveText('/tmp/narad-library/' + bundle.id);
  await panel.getByRole('button', { name: 'Open folder' }).click();
  await expect.poll(() => revealed).toContain('/reveal');
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0].action).toBe('continue');
  await panel.getByRole('button', { name: 'Start over', exact: true }).click();
  await expect(panel).toContainText('Start over? Finished sections move to the runs/ archive.');
  await panel.getByRole('button', { name: 'Cancel' }).click();
  expect(posts.length).toBe(1);
  await panel.getByRole('button', { name: 'Start over', exact: true }).click();
  await panel.getByRole('button', { name: 'Confirm' }).click();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1].action).toBe('restart');
  await panel.getByLabel('Learner level').selectOption('advanced');
  await panel.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(panel).toContainText('Changing the level starts over. Finished sections are kept in the preparation folder’s runs/ archive.');
  expect(posts.length).toBe(2);
});

test('presentation mode shows the credit line under the held figure', async ({ page, request }) => {
  expect((await request.post('/api/lessons', { data: mediaLesson('credit-present') })).ok()).toBe(true);
  await page.goto('/#lesson/credit-present');
  await page.locator('#block-fig-a .passage-marker').click();
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  await expect(page.locator('.presentation-figure .credit-line')).toContainText('From The Source Page');
});

test('presentation mode can ask the tutor about the passage it was opened on', async ({ page, request }) => {
  const id = await copyOf(request, 'gradient-descent', 'present-ask-copy');
  await page.route('**/api/speech', route => route.fulfill({ json: { state: 'ready', model: 'Fixture' } }));
  await page.goto('/#lesson/' + id);
  await page.getByRole('tab', { name: 'Detailed walkthrough' }).click();
  await page.getByRole('button', { name: 'Set reading position at g-step', exact: true }).click();
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  const stage = page.getByRole('dialog', { name: /^Presenting/ });
  await expect(stage.locator('.presentation-ask')).toHaveCount(0);
  await stage.getByRole('button', { name: 'Ask tutor' }).click();
  await expect(stage.locator('.presentation-ask').getByLabel('Question for the tutor')).toBeVisible();
  await page.keyboard.press('Escape'); // Leaves presentation; reopening starts with the panel closed.
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  await expect(stage.locator('.presentation-ask')).toHaveCount(0);
  await page.keyboard.press('a');
  await expect(stage.locator('.presentation-ask')).toBeVisible();
  const count = await stage.locator('.presentation-count').textContent();
  // The panel stays on the passage it was opened on while the slide moves.
  await page.keyboard.press('ArrowRight');
  await expect(stage.locator('.presentation-count')).not.toHaveText(count!);
  await expect(stage.locator('.presentation-ask')).toBeVisible();
  await stage.getByRole('button', { name: 'Back to current passage' }).click();
  await expect(stage.getByRole('button', { name: 'Back to current passage' })).toHaveCount(0);
  // Swiping inside the panel never changes the slide.
  const after = await stage.locator('.presentation-count').textContent();
  await stage.locator('.presentation-ask').evaluate(panel => {
    const make = (type: string, x: number) => new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [new Touch({ identifier: 1, target: panel, clientX: x, clientY: 200 })], changedTouches: [new Touch({ identifier: 1, target: panel, clientX: x, clientY: 200 })] });
    panel.dispatchEvent(make('touchstart', 300)); panel.dispatchEvent(make('touchend', 50));
  });
  await expect(stage.locator('.presentation-count')).toHaveText(after!);
  await page.keyboard.press('a');
  await expect(stage.locator('.presentation-ask')).toHaveCount(0);
});

test('on a phone the tutor panel leaves the presentation controls usable and closes with its own button', async ({ page, request }) => {
  const id = await copyOf(request, 'gradient-descent', 'present-ask-phone');
  await page.route('**/api/speech', route => route.fulfill({ json: { state: 'ready', model: 'Fixture' } }));
  await page.goto('/#lesson/' + id);
  await page.getByRole('tab', { name: 'Detailed walkthrough' }).click();
  await page.getByRole('button', { name: 'Set reading position at g-step', exact: true }).click();
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const stage = page.getByRole('dialog', { name: /^Presenting/ });
  await stage.getByRole('button', { name: 'Ask tutor' }).click();
  await expect(stage.locator('.presentation-ask')).toBeVisible();
  for (const name of ['Play narration', 'Next passage', 'Previous passage']) {
    const button = stage.getByRole('button', { name, exact: true });
    const covered = await button.evaluate(element => { const box = element.getBoundingClientRect(); const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2); return !hit || !element.contains(hit); });
    expect(covered, name).toBe(false);
  }
  const count = await stage.locator('.presentation-count').textContent();
  await stage.getByRole('button', { name: 'Next passage', exact: true }).click();
  await expect(stage.locator('.presentation-count')).not.toHaveText(count!);
  await stage.getByRole('button', { name: 'Close tutor panel' }).click();
  await expect(stage.locator('.presentation-ask')).toHaveCount(0);
});

test('a tutor draft in the presentation panel stays with its passage', async ({ page, request }) => {
  const id = await copyOf(request, 'gradient-descent', 'present-ask-draft');
  await page.route('**/api/speech', route => route.fulfill({ json: { state: 'ready', model: 'Fixture' } }));
  await page.goto('/#lesson/' + id);
  await page.getByRole('tab', { name: 'Detailed walkthrough' }).click();
  await page.getByRole('button', { name: 'Set reading position at g-step', exact: true }).click();
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  const stage = page.getByRole('dialog', { name: /^Presenting/ });
  await stage.getByRole('button', { name: 'Ask tutor' }).click();
  await stage.locator('.presentation-ask').getByLabel('Question for the tutor').fill('A draft about the first passage');
  await stage.getByRole('button', { name: 'Next passage', exact: true }).click();
  await stage.getByRole('button', { name: 'Back to current passage' }).click();
  await expect(stage.locator('.presentation-ask').getByLabel('Question for the tutor')).toHaveValue('');
});
