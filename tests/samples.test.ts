import { expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import samples from '../content/samples.json';
import { parseLesson } from '../shared/lesson';

it.each(samples)('validates every mode and saved asset in $id', sample => {
  const lesson = parseLesson(sample);
  expect(Object.keys(lesson.modes)).toHaveLength(3);
  for (const asset of lesson.assets) expect(existsSync('public' + asset.src)).toBe(true);
});
