// Takes the screenshots used by the introduction page in site/.
// Run against a Narad that holds only the bundled samples, so no personal library appears:
//   NARAD_WEB_URL=http://127.0.0.1:5178 node scripts/site-screenshots.mjs
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import sharp from 'sharp';

const base = process.env.NARAD_WEB_URL ?? 'http://127.0.0.1:5178';
const out = new URL('../site/assets/', import.meta.url).pathname;
const gradient = '#lesson/what-a-gradient-actually-tells-you';
const bayes = '#lesson/how-evidence-changes-your-mind';
await mkdir(out, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
async function page(width, height) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  const tab = await context.newPage();
  // Screenshots show the reader, not narration: speech requests are left unanswered and narration is paused before each shot.
  await tab.route('**/api/speech/render', () => {});
  return tab;
}
async function save(target, name, clip) {
  const png = await target.screenshot(clip ? { clip } : {});
  await sharp(png).webp({ quality: 86 }).toFile(out + name + '.webp');
  console.log('saved', name);
}
async function open(tab, hash, mode) {
  await tab.goto(base + '/' + hash);
  await tab.locator('.lesson-block').first().waitFor();
  if (mode) { await tab.locator('#tab-' + mode).click(); await tab.locator('.lesson-block').first().waitFor(); }
  await tab.waitForTimeout(400);
}
const show = (tab, selector) => tab.locator(selector).evaluate(element => element.scrollIntoView({ block: 'center' }));

const desktop = await page(1280, 820);
await desktop.goto(base + '/');
await desktop.locator('.library-row').first().waitFor();

await open(desktop, bayes, 'summary');
await save(desktop, 'mode-summary');
await open(desktop, gradient, 'walkthrough');
await show(desktop, '#block-g-figure');
await desktop.waitForTimeout(500);
await save(desktop, 'mode-walkthrough');
await open(desktop, bayes, 'dialogue');
await desktop.locator('.block-dialogue').nth(1).evaluate(element => element.scrollIntoView({ block: 'start' }));
await desktop.evaluate(() => window.scrollBy(0, -120));
await save(desktop, 'mode-dialogue');
await open(desktop, gradient, 'course');
await save(desktop, 'mode-course');

// Course details, cropped to the block itself.
const block = async (selector, name, prepare) => {
  if (prepare) await prepare();
  // The reading controls float over the page; hide them so they do not cover a tall block.
  await desktop.addStyleTag({ content: '.reading-controls{visibility:hidden}' });
  await show(desktop, selector);
  await desktop.waitForTimeout(300);
  const box = await desktop.locator(selector).boundingBox();
  await save(desktop, name, { x: Math.max(0, box.x - 28), y: Math.max(0, box.y - 14), width: box.width + 56, height: Math.min(box.height + 28, 800) });
};
await block('#block-c-rate-worked .worked', 'course-worked', async () => {
  const next = desktop.locator('#block-c-rate-worked .worked-actions .secondary-button');
  await next.click(); await next.click();
});
await block('#block-c-slope-check-0 .quiz', 'course-quiz', () => desktop.locator('#block-c-slope-check-0 .quiz-option').filter({ hasText: 'A small increase in x' }).click());
await block('#block-c-update-map .concept-diagram', 'course-diagram');

// Presentation: the diagram stays on screen while the check question is asked.
await desktop.locator('#block-c-update-check-0 .passage-marker').click();
await desktop.keyboard.press('p');
await desktop.locator('.presentation .quiz').waitFor();
await desktop.locator('.presentation-play').click();
await desktop.locator('.presentation-status', { hasText: 'Paused' }).waitFor();
await desktop.locator('.presentation-top').hover();
await desktop.waitForTimeout(600);
await save(desktop, 'presentation');
await desktop.keyboard.press('Escape');

// Ask the tutor about one passage.
await open(desktop, gradient, 'walkthrough');
await desktop.locator('#block-g-convergence').locator('xpath=..').getByRole('button', { name: /Ask tutor/ }).click();
await desktop.locator('.tutor-composer textarea').fill('Why does the learning rate have to stay below 1 here? What goes wrong just above it?');
await desktop.locator('.tutor-composer').evaluate(element => element.scrollIntoView({ block: 'center' }));
await desktop.waitForTimeout(300);
await save(desktop, 'tutor');

// Adding a lesson.
await desktop.goto(base + '/');
await desktop.getByRole('button', { name: 'Add a lesson' }).first().click();
await desktop.locator('dialog[open]').waitFor();
await desktop.locator('dialog[open] textarea').first().fill('Teach me how attention works in transformers, starting from the intuition.\nhttps://example.org/an-article-on-attention');
await desktop.waitForTimeout(300);
await save(desktop, 'add-lesson');

// On a phone.
const phone = await page(390, 780);
await open(phone, gradient, 'course');
await show(phone, '#block-c-update-check-0 .quiz');
await phone.waitForTimeout(300);
await save(phone, 'phone-course');
await phone.locator('#block-c-update-map .passage-marker').click();
await phone.locator('.speech-present').click();
await phone.locator('.presentation-diagram').waitFor();
await phone.locator('.presentation-play').click();
await phone.locator('.presentation-status', { hasText: 'Paused' }).waitFor();
await phone.waitForTimeout(600);
await save(phone, 'phone-present');

await browser.close();
