import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { z } from 'zod';
import { compileTeachingLesson, splitSourceSections, type AuthoredSection } from '../server/lesson-preparation';
import { parseLesson } from '../shared/lesson';
import { numericTokens } from '../server/generation-content';
import type { SourceBundle } from '../shared/sources';

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error('Usage: node --import tsx scripts/publish-prepared-lesson.ts <manifest.json> [--publish]');
const root = dirname(resolve(manifestPath));
const manifest = z.object({
  id: z.string(), title: z.string(), description: z.string(), topic: z.string(), bundleId: z.string(),
  contentFiles: z.array(z.string()).min(1), summaryFile: z.string(),
}).parse(JSON.parse(await readFile(manifestPath, 'utf8')));
const base = process.env.NARAD_API_URL ?? 'http://127.0.0.1:4318';
const response = await fetch(base + '/api/source-bundles/' + encodeURIComponent(manifest.bundleId));
if (!response.ok) throw new Error('Could not load captured source: HTTP ' + response.status);
const bundle = await response.json() as SourceBundle;
const authored: AuthoredSection[] = [];
for (const file of manifest.contentFiles) authored.push(...JSON.parse(await readFile(resolve(root, file), 'utf8')).sections);
const summary = JSON.parse(await readFile(resolve(root, manifest.summaryFile), 'utf8'));
const lesson = compileTeachingLesson({ ...manifest, bundle, authored, summary });
const source = bundle.sources.find(source => source.kind === 'article')!;

const numbers = numericTokens;
const missingNumbers: { unit: string; mode: string; values: string[] }[] = [];
for (const section of splitSourceSections(source.markdown)) for (const unit of section.units) {
  if (unit.kind !== 'text') continue; // Tables and visual originals are retained verbatim.
  const teaching = authored.find(item => item.id === section.id)!.units.find(item => item.id === unit.id)!;
  for (const mode of ['walkthrough', 'dialogue'] as const) {
    const written = numbers(teaching[mode]);
    const missing = [...numbers(unit.markdown)].filter(number => !written.has(number));
    if (missing.length) missingNumbers.push({ unit: unit.id, mode, values: missing });
  }
}
const report = {
  sourceSections: splitSourceSections(source.markdown).length,
  sourceUnits: splitSourceSections(source.markdown).reduce((sum, section) => sum + section.units.length, 0),
  sourceVisuals: source.assets.length,
  modes: Object.fromEntries(Object.entries(lesson.modes).map(([mode, content]) => [mode, {
    sections: content!.sections.length,
    passages: content!.sections.reduce((sum, section) => sum + section.blocks.length, 0),
    figures: content!.sections.flatMap(section => section.blocks).filter(block => block.kind === 'figure').length,
    words: content!.sections.flatMap(section => section.blocks).map(block => block.spokenText).join(' ').split(/\s+/).length,
  }])),
  missingNumbers,
  note: 'Coverage checks detect missing source units, visuals, and numeric tokens. They do not establish factual accuracy or semantic equivalence; human/agent review is still required.',
};
await writeFile(resolve(root, 'coverage.json'), JSON.stringify(report, null, 2));
await writeFile(resolve(root, 'lesson.json'), JSON.stringify(parseLesson(lesson), null, 2));
console.log(JSON.stringify(report, null, 2));
if (missingNumbers.length) throw new Error('Review numerical coverage gaps before publishing. See coverage.json.');
if (process.argv.includes('--publish')) {
  const published = await fetch(base + '/api/lessons', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(lesson) });
  if (!published.ok) throw new Error('Lesson publication failed: ' + await published.text());
  console.log('Published ' + lesson.id + '.');
} else console.log('Prepared lesson.json. Run with --publish after reviewing it.');
