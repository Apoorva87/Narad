import { describe, expect, it } from 'vitest';
import { defaultSettings, renderPrompt, resolveSettings, settingsOverrides, settingsSchema } from '../shared/settings';
import { LessonStore } from '../server/store';
import { researchSchema } from '../server/generation-content';

describe('settings', () => {
  it('ships valid defaults and fills only known slots', () => {
    expect(settingsSchema.safeParse(defaultSettings).success).toBe(true);
    expect(defaultSettings.preparation).toMatchObject({ codexModel: 'gpt-6-sol', codexReasoning: 'low', sectionsAtOnce: 5 });
    expect(renderPrompt('Hi {{ level }} and {{other}}', { level: 'advanced' })).toBe('Hi advanced and {{other}}');
  });
  it('limits lessons prepared at once to 1–5, defaulting to 1', () => {
    expect(defaultSettings.preparation.lessonsAtOnce).toBe(1);
    for (const value of [1, 3, 5]) { const s = structuredClone(defaultSettings); s.preparation.lessonsAtOnce = value; expect(settingsSchema.safeParse(s).success).toBe(true); }
    for (const value of [0, 6, 1.5]) { const s = structuredClone(defaultSettings); s.preparation.lessonsAtOnce = value; expect(settingsSchema.safeParse(s).success).toBe(false); }
  });
  it('allows up to five section writers in parallel and defaults to five', () => {
    for (const value of [1, 2, 3, 4, 5]) { const s = structuredClone(defaultSettings); s.preparation.sectionsAtOnce = value; expect(settingsSchema.safeParse(s).success).toBe(true); }
    for (const value of [0, 6, 1.5]) { const s = structuredClone(defaultSettings); s.preparation.sectionsAtOnce = value; expect(settingsSchema.safeParse(s).success).toBe(false); }
  });
  it('rejects prompts that drop a required slot or use an unknown one', () => {
    const missing = structuredClone(defaultSettings); missing.prompts.section = 'Explain it.';
    expect(settingsSchema.safeParse(missing).error?.issues[0].message).toMatch(/\{\{input\}\}/);
    const unknown = structuredClone(defaultSettings); unknown.prompts.summary += ' {{sumary}}';
    expect(settingsSchema.safeParse(unknown).error?.issues[0].message).toMatch(/unknown slot \{\{sumary\}\}/);
    const tooMany = structuredClone(defaultSettings); tooMany.research.maxLinks = 10;
    expect(settingsSchema.safeParse(tooMany).success).toBe(false);
  });
  it('adds steered research limits with defaults that old saved settings pick up', () => {
    expect(defaultSettings.research).toEqual({ maxLinks: 4, summaryLinks: 1, deepLinks: 2, steeredMaxLinks: 10 });
    expect(resolveSettings({ research: { maxLinks: 3 }, capture: { maxLinks: 5 } }).research).toEqual({ maxLinks: 3, summaryLinks: 1, deepLinks: 2, steeredMaxLinks: 10 });
    // The steered limit is independent of the link limit for sources you add yourself.
    const independent = resolveSettings({ research: { steeredMaxLinks: 30 }, capture: { maxLinks: 4 } });
    expect(independent.research.steeredMaxLinks).toBe(30); expect(independent.capture.maxLinks).toBe(4);
    for (const [key, bad] of [['summaryLinks', 0], ['summaryLinks', 3], ['deepLinks', 5], ['steeredMaxLinks', 1], ['steeredMaxLinks', 31]] as const) { const s = structuredClone(defaultSettings); s.research[key] = bad; expect(settingsSchema.safeParse(s).success, key + ' ' + bad).toBe(false); }
    expect(defaultSettings.prompts.outline).toMatch(/\{\{request\}\}[\s\S]*\{\{parent\}\}/); expect(defaultSettings.prompts.steeredResearch).toMatch(/\{\{request\}\}[\s\S]*\{\{topics\}\}/);
    const missing = structuredClone(defaultSettings); missing.prompts.outline = 'Outline {{request}}';
    expect(settingsSchema.safeParse(missing).error?.issues[0].message).toMatch(/\{\{parent\}\}/);
  });
  it('adds the steering guidance as slots that an unsteered lesson and an older saved prompt both tolerate', () => {
    const p = defaultSettings.prompts;
    expect(p.section).toContain('{{courseGuidance}}\n{{steerGuidance}}\n'); expect(p.review).toContain('{{courseGuidance}}\n{{steerGuidance}}\n');
    expect(p.steerGuidance).toMatch(/coverage is "summary"[\s\S]*still states its values/); expect(p.steerGuidance).not.toMatch(/\{\{/);
    expect(p.steerSummary).toMatch(/one section per source[\s\S]*\{\{outline\}\}/); expect(p.summary).not.toContain('outline');
    expect(p.outline).not.toContain('{{principles}}'); expect(p.steeredResearch).not.toContain('{{principles}}'); expect(p.outline).toContain('{{level}}');
    // Prompts saved before these changes stay valid.
    const older = structuredClone(defaultSettings); older.prompts.outline = '{{principles}} Outline {{request}} {{parent}}'; older.prompts.section = '{{principles}} Write {{input}}'; older.prompts.review = 'Review {{source}} {{draft}}';
    expect(settingsSchema.safeParse(older).success).toBe(true);
    const missing = structuredClone(defaultSettings); missing.prompts.steerSummary = 'Follow the topics.';
    expect(settingsSchema.safeParse(missing).error?.issues[0].message).toMatch(/\{\{outline\}\}/);
  });
  it('lets topic research return as many links as its setting allows, up to the capture limit', () => {
    const eight = structuredClone(defaultSettings); eight.research.maxLinks = 8;
    expect(settingsSchema.safeParse(eight).success).toBe(true);
    const links = Array.from({ length: 8 }, (_, n) => 'https://example.com/' + n);
    expect(researchSchema.parse({ links, rationale: '' }).links).toHaveLength(8);
    const capped = researchSchema.extend({ links: researchSchema.shape.links.max(8) });
    expect(capped.safeParse({ links, rationale: '' }).success).toBe(true); expect(capped.safeParse({ links: [...links, 'https://example.com/9'], rationale: '' }).success).toBe(false);
  });
  it('stores only changed values and ignores stale saved keys', () => {
    const changed = structuredClone(defaultSettings); changed.voice.host = 'Vivian';
    expect(settingsOverrides(changed)).toEqual({ voice: { host: 'Vivian' } });
    expect(resolveSettings({ voice: { host: 'Vivian', retired: true }, gone: { x: 1 } }).voice.host).toBe('Vivian');
    const store = new LessonStore(':memory:');
    try { expect('reviewRounds' in store.saveSettings(changed).preparation).toBe(false); expect(store.getSettings().voice.host).toBe('Vivian'); }
    finally { store.close(); }
  });
  it('does not impose dialogue-length or revision-count limits', () => {
    expect('reviewRounds' in defaultSettings.preparation).toBe(false);
    expect(defaultSettings.prompts.visualGuidance).not.toMatch(/2[–-]12|maximum.*turn/i);
    expect(defaultSettings.prompts.visualGuidance).toMatch(/as many.*turns.*needed/i);
  });
  it('keeps generated dialogue roles structural and separates host questions from expert answers', () => {
    expect(defaultSettings.prompts.section).toMatch(/hostQuestion and each unit question are only the host/i);
    expect(defaultSettings.prompts.section).toMatch(/dialogue and dialogueSpoken are only the expert/i);
    expect(defaultSettings.prompts.dialogueGuidance).toMatch(/never Host:, Expert:/);
    expect(defaultSettings.prompts.visualGuidance).toMatch(/role identifies the speaker/i);
    expect(defaultSettings.prompts.revision).toMatch(/remove speaker labels\/transcript formatting/i);
    expect(defaultSettings.prompts.summary).toMatch(/no Host:\/Expert: labels/i);
  });
});
