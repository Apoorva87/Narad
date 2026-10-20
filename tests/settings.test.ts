import { describe, expect, it } from 'vitest';
import { defaultSettings, renderPrompt, resolveSettings, settingsOverrides, settingsSchema } from '../shared/settings';
import { LessonStore } from '../server/store';

describe('settings', () => {
  it('ships valid defaults and fills only known slots', () => {
    expect(settingsSchema.safeParse(defaultSettings).success).toBe(true);
    expect(defaultSettings.preparation).toMatchObject({ codexModel: 'gpt-6-sol', codexReasoning: 'low', sectionsAtOnce: 3 });
    expect(renderPrompt('Hi {{ level }} and {{other}}', { level: 'advanced' })).toBe('Hi advanced and {{other}}');
  });
  it('limits lessons prepared at once to 1–3, defaulting to 1', () => {
    expect(defaultSettings.preparation.lessonsAtOnce).toBe(1);
    for (const value of [1, 2, 3]) { const s = structuredClone(defaultSettings); s.preparation.lessonsAtOnce = value; expect(settingsSchema.safeParse(s).success).toBe(true); }
    for (const value of [0, 4, 1.5]) { const s = structuredClone(defaultSettings); s.preparation.lessonsAtOnce = value; expect(settingsSchema.safeParse(s).success).toBe(false); }
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
