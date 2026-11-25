import { test, expect } from '@playwright/test';

test('the course mode shows key points, a teaching diagram and check questions that give feedback and a score', async ({ page, request }) => {
  const lesson = await (await request.get('/api/lessons/what-a-gradient-actually-tells-you')).json();
  expect((await request.post('/api/lessons', { data: { ...lesson, id: 'course-copy', isSample: false, title: 'Course copy' } })).ok()).toBe(true);
  await page.goto('/#lesson/course-copy');
  await page.getByRole('tab', { name: 'Course' }).click();
  await expect(page.locator('#block-c-slope-goal')).toContainText('What you will learn');
  await expect(page.locator('#block-c-update-map .concept-diagram svg')).toBeVisible();
  await expect(page.locator('#block-c-update-map')).toContainText('Step = learning rate');
  await expect(page.locator('.quiz-score')).toContainText('4 check questions to try');

  const quiz = page.locator('#block-c-slope-check-0');
  await expect(quiz.locator('.quiz-feedback')).toHaveCount(0);
  await quiz.getByRole('button', { name: /has the value six/ }).click();
  await expect(quiz.locator('.quiz-feedback')).toContainText('Not quite');
  await expect(quiz.locator('.quiz-correct')).toContainText('A small increase in x');
  await expect(page.locator('.quiz-score')).toContainText('0 of 1 right on the first try');
  // A second attempt can be answered correctly, but the score counts the first try.
  await quiz.getByRole('button', { name: 'Try again' }).click();
  await quiz.getByRole('button', { name: /A small increase in x/ }).click();
  await expect(quiz.locator('.quiz-feedback')).toContainText('Correct.');
  await expect(page.locator('.quiz-score')).toContainText('0 of 1 right on the first try · 3 still to answer');

  // A worked example hides its steps until asked, one at a time.
  const worked = page.locator('#block-c-rate-worked');
  await expect(worked).toContainText('Work it by hand');
  await expect(worked.locator('.worked-steps li')).toHaveCount(0);
  await worked.getByRole('button', { name: 'Show the first step' }).click();
  await expect(worked.locator('.worked-steps li')).toHaveCount(1);
  await worked.getByRole('button', { name: 'Show all' }).click();
  await expect(worked.locator('.worked-steps li')).toHaveCount(3);
  await expect(worked.locator('.worked-result')).toContainText('After three steps');

  // Presentation holds the diagram on screen and offers the same question to answer.
  await page.locator('#block-c-update-check-0 .passage-marker').click();
  await page.keyboard.press('p');
  await expect(page.locator('.presentation-diagram svg')).toBeVisible();
  await page.locator('.presentation .quiz-option').filter({ hasText: /^.?To x = 1$/ }).click();
  await expect(page.locator('.presentation .quiz-feedback')).toContainText('Correct.');
  await page.keyboard.press('Escape');
  await expect(page.locator('.quiz-score')).toContainText('1 of 2 right on the first try');
  await page.keyboard.press('2');
  await expect(page.getByRole('tab', { name: 'Detailed walkthrough' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('4');
  await expect(page.getByRole('tab', { name: 'Course' })).toHaveAttribute('aria-selected', 'true');
});
