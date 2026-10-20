import { test, expect } from '@playwright/test';
import { minimalLesson } from './fixture';

test('library search opens a complete reader with math and saved diagrams', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('searchbox', { name: 'Search lessons' }).fill('evidence');
  await expect(page.locator('.lesson-row')).toHaveCount(1);
  await page.locator('.lesson-row .library-row-main').click();
  await expect(page.getByRole('heading', { name: 'How evidence changes your mind' })).toBeVisible();
  await expect(page.locator('.katex')).not.toHaveCount(0);
  await expect(page.locator('.katex-error')).toHaveCount(0);
  await expect(page.locator('figure img')).toHaveCount(1);
  await page.locator('figure img').scrollIntoViewIfNeeded();
  await expect.poll(() => page.locator('figure img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
});

test('keyboard skip link preserves the open lesson route', async ({ page }) => {
  await page.goto('/#lesson/bayesian-reasoning');
  await expect(page.getByRole('heading', { name: 'How evidence changes your mind' })).toBeVisible();
  await page.locator('.skip-link').focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#lesson\/how-evidence-changes-your-mind$/);
  await expect(page.locator('#main-content')).toBeFocused();
  await expect(page.getByRole('heading', { name: 'How evidence changes your mind' })).toBeVisible();
});

test('reading position and mode survive refresh without crossing modes', async ({ page }) => {
  await page.goto('/#lesson/bayesian-reasoning');
  await page.getByRole('tab', { name: 'Detailed walkthrough' }).click();
  await page.getByRole('button', { name: 'Set reading position at b-result', exact: true }).click();
  await expect(page.locator('.reading-status [role="status"]')).toHaveText('Position saved locally');
  await page.reload();
  await expect(page.locator('.active-block')).toHaveAttribute('id', 'block-b-result');
  await page.getByRole('tab', { name: 'Quick summary' }).click();
  await expect(page.locator('.active-block')).toHaveAttribute('id', 'block-b-summary');
  await expect(page.locator('.reading-status [role="status"]')).toHaveText('Position saved locally');
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Quick summary' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Detailed walkthrough' }).click();
  await expect(page.locator('.active-block')).toHaveAttribute('id', 'block-b-result');
});

test('source dialog opens exact source content and restores focus on Escape', async ({ page }) => {
  await page.goto('/#lesson/gradient-descent');
  const sourceButton = page.getByRole('button', { name: '1 source', exact: true });
  await sourceButton.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByText(/A zero gradient can occur at a minimum/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(sourceButton).toBeFocused();
});

test('dialogue retains its diagram and changes the displayed content', async ({ page }) => {
  await page.goto('/#lesson/bayesian-reasoning');
  await page.getByRole('tab', { name: 'Tutor dialogue' }).click();
  await expect(page.locator('.speaker')).toHaveCount(7);
  await expect(page.locator('figure img')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: '“Ninety percent” sounds convincing' })).toBeVisible();
});

test('import rejects malformed JSON and accepts a single-mode lesson', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add a lesson', exact: true }).last().click();
  await page.getByRole('button', { name: 'Import a prepared lesson' }).click();
  const input = page.getByLabel('Lesson JSON file');
  await input.setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{') });
  await expect(page.getByRole('alert')).toContainText('not valid JSON');
  const lesson = minimalLesson();
  lesson.id = 'browser-fixture'; lesson.title = 'A single-mode imported lesson';
  await input.setInputFiles({ name: 'valid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(lesson)) });
  await expect(page.getByRole('heading', { name: lesson.title })).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.getByRole('tab', { name: 'Detailed walkthrough' })).toBeVisible();
});

test('lesson export contains exact formulas and spoken text', async ({ page }) => {
  await page.goto('/#lesson/bayesian-reasoning');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export lesson' }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const lesson = JSON.parse(Buffer.concat(chunks).toString());
  const blocks = lesson.modes.walkthrough.sections.flatMap((s: any) => s.blocks);
  expect(blocks.find((b: any) => b.id === 'b-result').latex).toContain('\\frac{90}{585}');
  expect(blocks.every((b: any) => b.spokenText.length > 0)).toBe(true);
});

test('mobile reader fits the viewport and diagrams can be enlarged', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#lesson/gradient-descent');
  await page.getByRole('tab', { name: 'Detailed walkthrough' }).click();
  await page.getByRole('button', { name: /Enlarge diagram/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').locator('img')).toBeVisible();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await page.getByRole('button', { name: 'Your library', exact: false }).first().click();
  await expect(page.getByRole('heading', { name: 'Your learning library' })).toBeVisible();
});

test('a passage opens an editable contextual tutor composer', async ({ page }) => {
  await page.goto('/#lesson/bayesian-reasoning');
  await page.getByRole('button', { name: 'Ask tutor' }).first().click();
  await expect(page.getByLabel('Question for the tutor').first()).toBeVisible();
  await page.getByLabel('Question for the tutor').first().fill('Why does this evidence change the probability?');
  await page.getByLabel('Answer scope').first().selectOption('research');
  await expect(page.getByText('The agent may search the web and will show citations.').first()).toBeVisible();
  await expect(page.getByText('Voice is transcribed here first so you can edit it before sending.').first()).toBeVisible();
});
