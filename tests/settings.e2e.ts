import { test, expect } from '@playwright/test';

test.afterEach(async ({ request }) => {
  // Settings are shared by every later test file; restore the defaults.
  const { defaults } = await (await request.get('/api/settings')).json();
  await request.patch('/api/settings', { data: defaults });
});

test('settings open from the library, validate prompts, save, and reset', async ({ page, request }) => {
  await page.goto('/');
  await page.locator('.library-actions').getByRole('button', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/#settings$/);
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();

  const section = page.getByLabel('Section writing', { exact: true });
  await section.fill('Explain the section clearly.');
  await expect(page.getByText(/Section writing must include \{\{input\}\}/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await page.locator('.setting-field').filter({ has: section }).getByRole('button', { name: '{{input}}' }).click();
  await expect(section).toHaveValue(/\{\{input\}\}/);

  await page.getByLabel('Detailed walkthrough', { exact: true }).fill('Explain like a careful textbook. Keep every source number.');
  await page.getByLabel('Host voice', { exact: true }).selectOption('Vivian');
  await expect(page.getByLabel('Review rounds per section', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Settings saved. They apply to your next preparation.')).toBeVisible();

  const saved = (await (await request.get('/api/settings')).json()).settings;
  expect(saved.prompts.walkthroughGuidance).toBe('Explain like a careful textbook. Keep every source number.');
  expect(saved.voice.host).toBe('Vivian');
  expect('reviewRounds' in saved.preparation).toBe(false);

  await page.reload();
  await expect(page.getByLabel('Host voice', { exact: true })).toHaveValue('Vivian');
  const walkthrough = page.locator('.setting-field').filter({ has: page.getByLabel('Detailed walkthrough', { exact: true }) });
  await expect(walkthrough.locator('.modified-badge')).toBeVisible();
  await walkthrough.getByRole('button', { name: /Reset/ }).click();
  await expect(walkthrough.locator('.modified-badge')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Settings saved. They apply to your next preparation.')).toBeVisible();
  expect((await (await request.get('/api/settings')).json()).settings.prompts.walkthroughGuidance).toMatch(/^Write an independently worded detailed walkthrough/);
});

test('reader voice changes are saved as settings', async ({ page, request }) => {
  await page.route('**/api/speech', route => route.fulfill({ json: { state: 'ready', model: 'Fixture' } }));
  await page.goto('/#lesson/gradient-descent');
  await page.getByRole('button', { name: 'Voice settings' }).click();
  await page.getByLabel('Narrator voice').selectOption('Serena');
  await expect.poll(async () => (await (await request.get('/api/settings')).json()).settings.voice.narrator).toBe('Serena');
});
