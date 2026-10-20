import { describe, expect, it } from 'vitest';
import { defaultSettings, renderPrompt, resolveSettings, settingsOverrides, settingsSchema } from '../shared/settings';
import { LessonStore } from '../server/store';

describe('settings', () => {
  it('ships valid defaults and fills only known slots', () => {
    expect(settingsSchema.safeParse(defaultSettings).success).toBe(true);
    expect(renderPrompt('Hi {{ level }} and {{other}}', { level: 'advanced' })).toBe('Hi advanced and {{other}}');
  });
  it('rejects prompts that drop a required slot or use an unknown one', () => {
    const missing = structuredClone(defaultSettings); missing.prompts.section = 'Explain it.';
    expect(settingsSchema.safeParse(missing).error?.issues[0].message).toMatch(/\{\{input\}\}/);
    const unknown = structuredClone(defaultSettings); unknown.prompts.summary += ' {{sumary}}';
    expect(settingsSchema.safeParse(unknown).error?.issues[0].message).toMatch(/unknown slot \{\{sumary\}\}/);
    const tooMany = structuredClone(defaultSettings); tooMany.research.maxLinks = 10;
    expect(settingsSchema.safeParse(tooMany).success).toBe(false);
  });
  it('stores only changed values and ignores stale saved keys', () => {
    const changed = structuredClone(defaultSettings); changed.voice.host = 'Vivian'; changed.preparation.reviewRounds = 3;
    expect(settingsOverrides(changed)).toEqual({ voice: { host: 'Vivian' }, preparation: { reviewRounds: 3 } });
    expect(resolveSettings({ voice: { host: 'Vivian', retired: true }, gone: { x: 1 } }).voice.host).toBe('Vivian');
    const store = new LessonStore(':memory:');
    try { expect(store.saveSettings(changed).preparation.reviewRounds).toBe(3); expect(store.getSettings().voice.host).toBe('Vivian'); }
    finally { store.close(); }
  });
});
