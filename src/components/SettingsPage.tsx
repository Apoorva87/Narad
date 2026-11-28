import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, LoaderCircle, RotateCcw } from 'lucide-react';
import { familiarities, familiarityLabels } from '../../shared/lesson';
import { providers } from '../../shared/preparation';
import { speechEngineLabels, speechEngines, voices } from '../../shared/speech';
import { promptInfo, settingsSchema, slotDescriptions, type PromptKey, type Settings } from '../../shared/settings';
import { api } from '../lib/api';
import { replaceSettings } from '../lib/settings';

type Section = keyof Settings;
const sections: { id: string; title: string; description: string }[] = [
  { id: 'modes', title: 'Learning modes', description: 'How the brief summary, detailed walkthrough, tutor dialogue, course and figure explanations are written.' },
  { id: 'teaching', title: 'Teaching principles', description: 'Editable pedagogy sent with every step. Narad adds a separate fixed trust policy that source material and learner text cannot override.' },
  { id: 'steps', title: 'Agent steps', description: 'The full instruction for each step of preparation. Slots in {{braces}} are filled in when a preparation runs.' },
  { id: 'preparation', title: 'Preparation', description: 'Which agent and model to use, and how hard the reviewer works.' },
  { id: 'capture', title: 'Research & capture', description: 'Limits for finding and saving sources.' },
  { id: 'lessons', title: 'Lessons', description: 'Defaults for new lessons and the dialogue speakers.' },
  { id: 'voice', title: 'Voice', description: 'Default narration voices, speed and speaking style.' },
];
const promptsBySection: Record<string, PromptKey[]> = {
  modes: ['summary', 'walkthroughGuidance', 'dialogueGuidance', 'courseGuidance', 'visualGuidance', 'steerGuidance'],
  teaching: ['principles', 'levelFoundational', 'levelSomeBackground', 'levelAdvanced'],
  steps: ['research', 'outline', 'steeredResearch', 'section', 'revision', 'review', 'steerSummary'],
  voice: ['hostStyle', 'tutorStyle'],
};

export function SettingsPage({ onBack }: { onBack: () => void }) {
  const [saved, setSaved] = useState<Settings | null>(null);
  const [defaults, setDefaults] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [status, setStatus] = useState<{ kind: 'idle' | 'saving' | 'saved' | 'error'; message?: string }>({ kind: 'idle' });
  useEffect(() => {
    api.settings().then(response => { setSaved(response.settings); setDraft(response.settings); setDefaults(response.defaults); })
      .catch(error => setStatus({ kind: 'error', message: error instanceof Error ? error.message : 'Could not load settings.' }));
  }, []);
  const dirty = !!draft && !!saved && JSON.stringify(draft) !== JSON.stringify(saved);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  if (!draft || !defaults) return <div className="settings-view">{status.kind === 'error' ? <p className="error-box" role="alert">{status.message}</p> : <div className="loading-state" role="status"><LoaderCircle size={28} className="spin" /><p>Opening settings…</p></div>}</div>;

  const validation = settingsSchema.safeParse(draft);
  const errors = new Map<string, string>();
  if (!validation.success) for (const issue of validation.error.issues) { const key = issue.path.slice(0, 2).join('.'); if (!errors.has(key)) errors.set(key, issue.message); }
  function set<S extends Section, K extends keyof Settings[S]>(section: S, key: K, value: Settings[S][K]) {
    setDraft(previous => previous && { ...previous, [section]: { ...previous[section], [key]: value } });
    if (status.kind !== 'saving') setStatus({ kind: 'idle' });
  }
  async function save() {
    setStatus({ kind: 'saving' });
    try { const response = await api.saveSettings(draft!); setSaved(response.settings); setDraft(response.settings); replaceSettings(response.settings); setStatus({ kind: 'saved' }); }
    catch (error) { setStatus({ kind: 'error', message: error instanceof Error ? error.message : 'Could not save settings.' }); }
  }
  const field = <S extends Section, K extends keyof Settings[S] & string>(section: S, key: K) => ({
    id: 'setting-' + section + '-' + key, value: draft[section][key], fallback: defaults[section][key], error: errors.get(section + '.' + key),
    onChange: (value: Settings[S][K]) => set(section, key, value), onReset: () => set(section, key, defaults[section][key]),
  });

  return <div className="settings-view">
    <header className="settings-heading">
      <button className="back-link" onClick={() => { if (!dirty || window.confirm('Leave without saving your settings changes?')) onBack(); }}><ArrowLeft size={16} />Your library</button>
      <h1>Settings</h1>
      <p className="page-description">Changes apply to lessons you prepare from now on. Existing lessons stay as they are; regenerate one to use new settings.</p>
    </header>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">{sections.map(section => <button key={section.id} onClick={() => document.getElementById('settings-' + section.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{section.title}</button>)}</nav>
      <div className="settings-content">
        {sections.map(section => <section key={section.id} id={'settings-' + section.id} className="settings-section" aria-labelledby={'settings-title-' + section.id}>
          <h2 id={'settings-title-' + section.id}>{section.title}</h2><p className="settings-section-description">{section.description}</p>
          {section.id === 'preparation' && <div className="settings-grid">
            <ChoiceField label="Default agent" {...field('preparation', 'defaultProvider')} options={providers.map(id => [id, id === 'codex' ? 'Codex' : 'Claude'])} />
            <TextField label="Codex model" hint="Leave empty for the Codex default. Passed as codex -m." {...field('preparation', 'codexModel')} />
            <ChoiceField label="Codex reasoning" hint="Low is faster and cheaper; medium spends more time on difficult sections." {...field('preparation', 'codexReasoning')} options={[['low', 'Low'], ['medium', 'Medium']]} />
            <TextField label="Claude model" hint="Leave empty for the Claude default. Passed as claude --model." {...field('preparation', 'claudeModel')} />
            <NumberField label="Section size (characters)" hint="Source text sent per writing call. Smaller is more focused." min={2000} max={20000} step={500} {...field('preparation', 'chunkChars')} />
            <NumberField label="Paragraphs per writing call" hint="Upper bound on paragraphs and tables per call." min={2} max={20} {...field('preparation', 'chunkUnits')} />
            <NumberField label="Time limit per call (minutes)" hint="A step that runs longer is stopped." min={2} max={60} {...field('preparation', 'timeoutMinutes')} />
            <NumberField label="Section writers in parallel" hint="Independent sections delegated in parallel; reviews overlap the next writing batch." min={1} max={5} {...field('preparation', 'sectionsAtOnce')} />
            <NumberField label="Lessons at once" hint="How many lessons can prepare at the same time. Each runs its own sections in parallel on your agent account, so lessons × sections at once can hit rate limits." min={1} max={5} step={1} {...field('preparation', 'lessonsAtOnce')} />
          </div>}
          {section.id === 'capture' && <div className="settings-grid">
            <NumberField label="Links found by topic research" hint="Used when a lesson starts from notes only, without steering. Cannot exceed “Links per lesson”." min={1} max={12} {...field('research', 'maxLinks')} />
            <NumberField label="Steered research: links per Summary topic" hint="Articles found for each topic or sub-topic you keep on Summary." min={1} max={2} {...field('research', 'summaryLinks')} />
            <NumberField label="Steered research: links per Deeper topic" hint="Articles found for each topic or sub-topic you mark Deeper." min={1} max={4} {...field('research', 'deepLinks')} />
            <NumberField label="Steered research: most links per lesson" hint="Upper limit across all chosen topics; over it, Deeper topics give up links first. Independent of “Links per lesson”." min={2} max={30} {...field('research', 'steeredMaxLinks')} />
            <NumberField label="Links per lesson" hint="Article links you can add at once." min={1} max={12} {...field('capture', 'maxLinks')} />
            <NumberField label="Images per lesson" hint="Images you can add at once (5 MB each)." min={1} max={6} {...field('capture', 'maxImages')} />
          </div>}
          {section.id === 'lessons' && <div className="settings-grid">
            <ChoiceField label="Default level" {...field('lessons', 'defaultLevel')} options={familiarities.map(level => [level, familiarityLabels[level]])} />
            <TextField label="Host name" hint="The curious voice in the dialogue." {...field('lessons', 'hostName')} />
            <TextField label="Tutor name" hint="The expert voice in the dialogue." {...field('lessons', 'expertName')} />
          </div>}
          {section.id === 'voice' && <div className="settings-grid">
            <ChoiceField label="Voice model" hint="Runs on this Mac. If the chosen model is not installed, Narad uses the other one. Breeze TTS 2 is licensed for personal and research use only." {...field('voice', 'engine')} options={speechEngines.map(engine => [engine, speechEngineLabels[engine]])} />
            <ChoiceField label="Narrator voice" {...field('voice', 'narrator')} options={voices.map(voice => [voice, voice])} />
            <ChoiceField label="Host voice" {...field('voice', 'host')} options={voices.map(voice => [voice, voice])} />
            <ChoiceField label="Tutor voice" {...field('voice', 'expert')} options={voices.map(voice => [voice, voice])} />
            <ChoiceField label="Speed" {...field('voice', 'rate')} options={[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(rate => [rate, rate + '×'])} />
          </div>}
          {(promptsBySection[section.id] ?? []).map(key => <PromptField key={key} name={key} {...field('prompts', key)} />)}
        </section>)}
        <div className="settings-reset-all"><button className="text-link" onClick={() => setDraft(defaults)}><RotateCcw size={14} />Reset every setting to its default</button><span>Nothing changes until you save.</span></div>
      </div>
    </div>
    {(dirty || status.kind !== 'idle') && <div className="settings-savebar" role="region" aria-label="Save settings">
      <span role="status" className={status.kind === 'error' || !validation.success ? 'savebar-problem' : ''}>{status.kind === 'error' ? status.message : !validation.success ? 'Fix the highlighted ' + (errors.size === 1 ? 'setting' : errors.size + ' settings') + ' before saving.' : status.kind === 'saved' && !dirty ? 'Settings saved. They apply to your next preparation.' : 'You have unsaved changes.'}</span>
      {dirty && <><button className="secondary-button" onClick={() => { setDraft(saved); setStatus({ kind: 'idle' }); }} disabled={status.kind === 'saving'}>Discard</button>
        <button className="primary-button" onClick={() => void save()} disabled={status.kind === 'saving' || !validation.success}>{status.kind === 'saving' && <LoaderCircle size={15} className="spin" />}Save changes</button></>}
    </div>}
  </div>;
}

type FieldProps<T> = { id: string; label?: string; hint?: string; value: T; fallback: T; error?: string; onChange: (value: T) => void; onReset: () => void };
function Field({ id, label, hint, modified, error, onReset, children }: { id: string; label: ReactNode; hint?: ReactNode; modified: boolean; error?: string; onReset: () => void; children: ReactNode }) {
  return <div className={'setting-field' + (error ? ' has-error' : '')}>
    <div className="setting-label"><label htmlFor={id}>{label}</label>{modified && <span className="modified-badge">Modified</span>}
      <button className="text-link setting-reset" onClick={onReset} disabled={!modified} aria-label={'Reset ' + (typeof label === 'string' ? label : 'setting') + ' to default'}><RotateCcw size={13} />Reset</button></div>
    {hint && <p className="setting-hint">{hint}</p>}
    {children}
    {error && <p className="setting-error" role="alert">{error}</p>}
  </div>;
}
function NumberField({ min, max, step = 1, ...props }: FieldProps<number> & { min: number; max: number; step?: number }) {
  return <Field {...props} label={props.label} hint={<>{props.hint} {min}–{max}, default {props.fallback}.</>} modified={props.value !== props.fallback}>
    <input id={props.id} type="number" min={min} max={max} step={step} value={Number.isFinite(props.value) ? props.value : ''} onChange={event => props.onChange(event.target.valueAsNumber)} />
  </Field>;
}
function TextField(props: FieldProps<string>) {
  return <Field {...props} label={props.label} modified={props.value !== props.fallback}><input id={props.id} type="text" value={props.value} placeholder={props.fallback || 'Default'} onChange={event => props.onChange(event.target.value)} /></Field>;
}
function ChoiceField<T extends string | number>({ options, ...props }: FieldProps<T> & { options: [T, string][] }) {
  return <Field {...props} label={props.label} modified={props.value !== props.fallback}>
    <select id={props.id} value={String(props.value)} onChange={event => props.onChange(options.find(([value]) => String(value) === event.target.value)![0])}>{options.map(([value, label]) => <option key={String(value)} value={String(value)}>{label}{value === props.fallback ? ' (default)' : ''}</option>)}</select>
  </Field>;
}
function PromptField({ name, ...props }: FieldProps<string> & { name: PromptKey }) {
  const info = promptInfo[name]; const area = useRef<HTMLTextAreaElement>(null);
  const slots = [...info.required.map(slot => ({ slot, required: true })), ...info.optional.map(slot => ({ slot, required: false }))];
  function insert(slot: string, trigger: HTMLButtonElement) {
    const element = area.current; if (!element) return;
    const text = '{{' + slot + '}}'; const start = element.selectionStart, end = element.selectionEnd;
    props.onChange(props.value.slice(0, start) + text + props.value.slice(end));
    requestAnimationFrame(() => {
      // Do not steal focus if the learner has already moved to another setting.
      if (document.activeElement !== trigger) return;
      element.focus(); element.setSelectionRange(start + text.length, start + text.length);
    });
  }
  return <Field {...props} label={info.label} hint={info.description} modified={props.value !== props.fallback}>
    <textarea ref={area} id={props.id} className="prompt-editor" value={props.value} spellCheck={false} rows={Math.min(16, Math.max(3, props.value.split('\n').length + Math.ceil(props.value.length / 110)))} onChange={event => props.onChange(event.target.value)} />
    {slots.length > 0 && <div className="slot-list"><span>Insert:</span>{slots.map(({ slot, required }) => <button key={slot} type="button" className={'slot-chip' + (required ? ' required' : '')} title={slotDescriptions[slot] + (required ? ' · required' : '')} onClick={event => insert(slot,event.currentTarget)}>{'{{' + slot + '}}'}</button>)}</div>}
  </Field>;
}
