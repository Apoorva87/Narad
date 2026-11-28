import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Minus, Plus, Sparkles } from 'lucide-react';
import { steerMaxDepth, type PreparationJob, type SteerChoice, type SteerPatch, type SteerTopic, type SteeringPlan } from '../../shared/preparation';
import { api } from '../lib/api';
import { useSettings } from '../lib/settings';

const focusMax = 500;
const noteMax = 300;
const choiceLabels: Record<SteerChoice, string> = { deeper: 'Deeper', summary: 'Summary', skip: 'Skip' };

/** What the learner has picked for one topic. `note` is the optional per-topic focus. */
export type TopicDraft = { choice: SteerChoice; note: string };
/** The learner's edits as the page holds them, keyed by topic id. */
export type OutlineDraft = { focus: string; topics: Record<string, TopicDraft> };
/** `skipped` includes everything under a skipped topic; `unused` are sub-topics whose parent is not on Deeper; `active` is how many topics get research of their own. */
export type PickCounts = { total: number; deeper: number; summary: number; skipped: number; unused: number; active: number };
export type OutlineNode = { topic: SteerTopic; children: OutlineNode[] };

/** A draft that mirrors the server's plan exactly. */
export function seedOutline(plan: SteeringPlan): OutlineDraft {
  return { focus: plan.focus ?? '', topics: Object.fromEntries(plan.topics.map(topic => [topic.id, { choice: topic.choice, note: topic.note ?? '' }])) };
}
// The server trims what it stores, so its copy of "hello " is "hello": keep the learner's own text rather than moving the caret.
const text = (local: string, server: string) => server === local.trim() ? local : server;
/**
 * Folds a fresh server plan into the local draft. New topics are seeded, removed ones dropped, and every field the learner changed but has not yet saved
 * (`dirty` holds `focus`, `<id>.choice` and `<id>.note`) stays as typed. Returns the same object when nothing changed so a 2s poll does not re-render.
 */
export function mergeOutline(draft: OutlineDraft, plan: SteeringPlan, dirty: ReadonlySet<string>): OutlineDraft {
  const focus = dirty.has('focus') ? draft.focus : text(draft.focus, plan.focus ?? '');
  const topics: Record<string, TopicDraft> = {}; let changed = focus !== draft.focus || Object.keys(draft.topics).length !== plan.topics.length;
  for (const topic of plan.topics) {
    const local = draft.topics[topic.id];
    const choice = local && dirty.has(topic.id + '.choice') ? local.choice : topic.choice;
    const note = local ? dirty.has(topic.id + '.note') ? local.note : text(local.note, topic.note ?? '') : topic.note ?? '';
    if (local && local.choice === choice && local.note === note) topics[topic.id] = local; else { topics[topic.id] = { choice, note }; changed = true; }
  }
  return changed ? { focus, topics } : draft;
}
/** The picks "Keep it simple" confirms with: every topic at Summary. */
export function suggestedPicks(topics: SteerTopic[]): Record<string, SteerChoice> { return Object.fromEntries(topics.map(topic => [topic.id, 'summary' as const])); }
/** True for a plan older than one of the page's own saves (`seenRev`): it left the server before that save and must not be shown or merged. */
export function isStalePlan(plan: SteeringPlan, seenRev: number) { return (plan.rev ?? 0) < seenRev; }
/**
 * Counts picks the way research reads them: Skip leaves out the whole branch, a parent that is not on Deeper is one topic and its
 * sub-topics are not used, and a Deeper parent hands over to the sub-topics it keeps.
 */
export function countPicks(topics: SteerTopic[], picks: Record<string, TopicDraft>): PickCounts {
  const counts = { total: topics.length, deeper: 0, summary: 0, skipped: 0, unused: 0, active: 0 };
  const choiceOf = (topic: SteerTopic) => picks[topic.id]?.choice ?? topic.choice;
  const visit = (node: OutlineNode, state: 'kept' | 'skipped' | 'unused') => {
    if (state !== 'kept') { counts[state]++; node.children.forEach(child => visit(child, state)); return; }
    const choice = choiceOf(node.topic);
    if (choice === 'skip') { counts.skipped++; node.children.forEach(child => visit(child, 'skipped')); return; }
    if (choice === 'deeper') { counts.deeper++; if (!node.children.some(child => choiceOf(child.topic) !== 'skip')) counts.active++; node.children.forEach(child => visit(child, 'kept')); return; }
    counts.summary++; counts.active++; node.children.forEach(child => visit(child, 'unused'));
  };
  buildOutlineTree(topics).forEach(node => visit(node, 'kept'));
  return counts;
}
/** "4 topics · 1 deeper · 1 skipped · 2 not used"; zero counts are left out. */
export function countsLine(counts: PickCounts) { return [counts.total + (counts.total === 1 ? ' topic' : ' topics'), counts.deeper && counts.deeper + ' deeper', counts.skipped && counts.skipped + ' skipped', counts.unused && counts.unused + ' not used'].filter(Boolean).join(' · '); }
/** The reading cost of the picks as saved: what research will fetch, a normal lesson's limit for comparison, and a note when the cap trims the plan. */
export function costLine(budget: SteeringPlan['budget'], normalLinks: number) {
  const wanted = budget.wanted ?? budget.planned;
  return { main: 'About ' + budget.planned + (budget.planned === 1 ? ' article' : ' articles') + ' to read', normal: '(a normal lesson uses up to ' + normalLinks + ')', cap: budget.planned < wanted ? 'Capped at ' + budget.total + ' — ' + (wanted - budget.planned) + ' fewer than you asked for' : '' };
}
/** The per-topic focus disclosure's label: a closed one still shows that a note exists, and how it starts. */
export function noteLabel(note: string, open: boolean) {
  const words = note.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'Add a focus for this topic';
  return open ? 'Edit focus' : 'Focus: ' + words.slice(0, 6).join(' ') + (words.length > 6 ? '…' : '');
}
/** A rough wait for the two agent steps the learner sits through; other stages get none. */
export function waitHint(stage: string) { return /^(Drawing an outline|Breaking down)/.test(stage) ? 'This usually takes about a minute.' : ''; }
/** The flat, display-ordered topic list as a tree. A topic whose parent is missing is shown at the top level; nothing is shown twice. */
export function buildOutlineTree(topics: SteerTopic[]): OutlineNode[] {
  const byId = new Map(topics.map(topic => [topic.id, topic])); const seen = new Set<string>();
  const childrenOf = (topic: SteerTopic) => { const listed = (topic.children ?? []).map(id => byId.get(id)).filter((child): child is SteerTopic => !!child && child.parentId === topic.id); const rest = topics.filter(child => child.parentId === topic.id && !listed.includes(child)); return [...listed, ...rest]; };
  const grow = (topic: SteerTopic): OutlineNode => { seen.add(topic.id); return { topic, children: childrenOf(topic).filter(child => !seen.has(child.id)).map(grow) }; };
  return topics.filter(topic => !topic.parentId || !byId.has(topic.parentId)).map(grow);
}
/** Every pick as one patch, for the confirm call. */
export function fullPatch(draft: OutlineDraft): SteerPatch { return { focus: draft.focus, topics: Object.entries(draft.topics).map(([id, pick]) => ({ id, choice: pick.choice, note: pick.note })) }; }
function patchFor(draft: OutlineDraft, keys: string[]): SteerPatch {
  const patch: SteerPatch = {}; const topics = new Map<string, { id: string; choice?: SteerChoice; note?: string }>();
  for (const key of keys) {
    if (key === 'focus') { patch.focus = draft.focus; continue; }
    const dot = key.lastIndexOf('.'); const id = key.slice(0, dot); const field = key.slice(dot + 1); const pick = draft.topics[id]; if (!pick) continue;
    const entry = topics.get(id) ?? { id }; if (field === 'choice') entry.choice = pick.choice; else entry.note = pick.note; topics.set(id, entry);
  }
  if (topics.size) patch.topics = [...topics.values()];
  return patch;
}
const valueOf = (draft: OutlineDraft, key: string) => key === 'focus' ? draft.focus : draft.topics[key.slice(0, key.lastIndexOf('.'))]?.[key.endsWith('.choice') ? 'choice' : 'note'];

type CardProps = { topic: SteerTopic; pick: TopicDraft; readOnly: boolean; onChoice: (topic: SteerTopic, choice: SteerChoice) => void; onNote: (id: string, note: string) => void; onBlur: () => void; onBreak: (topic: SteerTopic) => void; onRemove: (topic: SteerTopic) => void };
function TopicCard({ topic, pick, readOnly, onChoice, onNote, onBlur, onBreak, onRemove }: CardProps) {
  const [open, setOpen] = useState(!!pick.note);
  const choices: SteerChoice[] = topic.depth >= steerMaxDepth ? ['summary', 'skip'] : ['deeper', 'summary', 'skip'];
  const noteId = 'outline-note-' + topic.id; const parent = !!topic.children?.length;
  return <fieldset className={'outline-card' + (pick.choice === 'skip' ? ' skipped' : '')} disabled={readOnly} data-topic={topic.id}>
    <legend className="sr-only">Coverage for {topic.title}</legend>
    <div className="outline-card-head"><strong className="outline-title">{topic.title}</strong>{topic.depth > 1 && <span className="outline-badge">sub-topic</span>}</div>
    {topic.blurb && <p className="outline-blurb">{topic.blurb}</p>}
    <div className="outline-choices" role="radiogroup" aria-label={'How much to cover of ' + topic.title} style={{ ['--choices' as string]: choices.length }}>{choices.map(choice => <label key={choice} className={pick.choice === choice ? 'selected' : ''}><input type="radio" name={'outline-choice-' + topic.id} value={choice} checked={pick.choice === choice} onChange={() => onChoice(topic, choice)} /><strong>{choiceLabels[choice]}</strong></label>)}</div>
    <div className="outline-card-links">
      <button type="button" className="text-link outline-note-toggle" aria-expanded={open} aria-controls={noteId} onClick={() => setOpen(!open)}>{open ? <Minus size={13} aria-hidden="true" /> : <Plus size={13} aria-hidden="true" />}<span>{noteLabel(pick.note, open)}</span></button>
      {parent ? <button type="button" className="text-link outline-structure" onClick={() => onRemove(topic)}>Remove sub-topics</button>
        : topic.depth < steerMaxDepth && pick.choice !== 'skip' && <button type="button" className="text-link outline-structure" title="Asks the agent to split this topic into parts you can pick from. This usually takes about a minute." onClick={() => onBreak(topic)}>Break into sub-topics</button>}
    </div>
    {open && <textarea id={noteId} className="outline-note" rows={2} maxLength={noteMax} aria-label={'Focus for ' + topic.title} placeholder="Anything in particular to cover or avoid?" value={pick.note} onChange={event => onNote(topic.id, event.target.value)} onBlur={onBlur} />}
  </fieldset>;
}
/** `covered` is false for cards under a topic that is skipped or not on Deeper: research ignores them, so they are dimmed. */
function Nodes({ nodes, nested, covered = true, drafts, ...rest }: { nodes: OutlineNode[]; nested?: boolean; covered?: boolean; drafts: Record<string, TopicDraft> } & Omit<CardProps, 'topic' | 'pick'>) {
  return <ul className={nested ? 'outline-list outline-children' : 'outline-list'}>{nodes.map(node => {
    const pick = drafts[node.topic.id] ?? { choice: node.topic.choice, note: node.topic.note ?? '' };
    // Only the topic that switches its sub-topics off carries the note and the dimming; everything below is already inside it.
    const off = covered && pick.choice !== 'deeper' && node.children.length > 0; const noteId = 'outline-unused-' + node.topic.id;
    return <li key={node.topic.id}>
      <TopicCard topic={node.topic} pick={pick} {...rest} />
      {off && <p id={noteId} className="outline-unused-note">{pick.choice === 'skip' ? 'Left out with this topic' : 'Not covered separately'} — set to Deeper to use these</p>}
      {node.children.length > 0 && <div className={off ? 'outline-unused' : undefined} role={off ? 'group' : undefined} aria-describedby={off ? noteId : undefined}><Nodes nodes={node.children} nested covered={covered && pick.choice === 'deeper'} drafts={drafts} {...rest} /></div>}
    </li>;
  })}</ul>;
}

/** Cards to pick Deeper / Summary / Skip for each topic of a steered run. Read-only while the agent is breaking a topic down. */
export function ResearchOutline({ job, onChanged }: { job: PreparationJob; onChanged: () => Promise<void> }) {
  const normalLinks = useSettings().research.maxLinks;
  // The plan on screen: the newest one from a poll or from this page's own writes, never one older than its own last write.
  const [plan, setPlan] = useState(job.steering!); const seenRev = useRef(0);
  const [draft, setDraft] = useState(() => seedOutline(plan));
  const draftRef = useRef(draft); const dirty = useRef(new Set<string>()); const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inflight = useRef<Promise<unknown> | null>(null); const closed = useRef(false);
  const root = useRef<HTMLDivElement>(null); const refocus = useRef<{ id: string; wait: boolean; rev: number }>(undefined);
  const [save, setSave] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle'); const [pending, setPending] = useState(false); const [error, setError] = useState(''); const [askSimple, setAskSimple] = useState(false);
  const commit = (next: OutlineDraft) => { draftRef.current = next; setDraft(next); };
  /** Takes a plan from the server. `own` marks a reply to this page's own write, which later polls must not undercut. */
  function adopt(next: SteeringPlan, own = false) {
    if (own) seenRev.current = Math.max(seenRev.current, next.rev ?? 0);
    if (isStalePlan(next, seenRev.current)) return;
    setPlan(next);
    // Adopt the structure but never a field the learner has changed and not yet saved.
    const merged = mergeOutline(draftRef.current, next, dirty.current); if (merged !== draftRef.current) commit(merged);
  }
  useEffect(() => { if (job.steering) adopt(job.steering); }, [job.steering]);
  const editable = job.status === 'awaiting-input' && !pending;
  // Disabling the cards while the agent works drops keyboard focus: put it back on the card that asked, once it can take it.
  // A breakdown is over when the run was seen working, the sub-topics arrived, or the plan moved past the one the request returned.
  useEffect(() => {
    const want = refocus.current; if (!want) return;
    if (job.status !== 'awaiting-input' || (plan.rev ?? 0) > want.rev || plan.topics.find(topic => topic.id === want.id)?.children?.length) want.wait = false;
    if (!editable || want.wait) return;
    refocus.current = undefined;
    const active = document.activeElement; if (active && active !== document.body && !root.current?.contains(active)) return;
    const cardNode = [...root.current?.querySelectorAll<HTMLElement>('[data-topic]') ?? []].find(node => node.dataset.topic === want.id);
    (cardNode?.querySelector<HTMLElement>('.outline-structure') ?? cardNode?.querySelector<HTMLElement>('input:checked'))?.focus();
  }, [editable, plan, job.status]);

  /** Saves pending edits. Resolves false when the save failed. */
  async function flush(): Promise<boolean> {
    clearTimeout(timer.current);
    while (inflight.current) await inflight.current;
    const keys = [...dirty.current];
    if (!keys.length) return true;
    const sent = draftRef.current; setSave('saving');
    const run = (async () => {
      try {
        const saved = await api.saveSteering(job.id, patchFor(sent, keys));
        for (const key of keys) if (valueOf(draftRef.current, key) === valueOf(sent, key)) dirty.current.delete(key);
        adopt(saved, true);
        if (dirty.current.size) schedule(); else setSave('saved');
        return true;
      } catch { setSave('error'); return false; }
    })();
    inflight.current = run.finally(() => { inflight.current = null; });
    return run;
  }
  function schedule() { clearTimeout(timer.current); timer.current = setTimeout(() => void flush(), 600); }
  const flushRef = useRef(flush); flushRef.current = flush;
  useEffect(() => () => { clearTimeout(timer.current); if (!closed.current && dirty.current.size) void flushRef.current(); }, []);

  // Every choice, Deeper included, is only a saved pick: nothing here starts an agent call.
  function pickChoice(topic: SteerTopic, choice: SteerChoice) {
    if (!editable) return;
    setError(''); dirty.current.add(topic.id + '.choice');
    commit({ ...draftRef.current, topics: { ...draftRef.current.topics, [topic.id]: { ...draftRef.current.topics[topic.id], choice } } }); schedule();
  }
  function setNote(id: string, note: string) { dirty.current.add(id + '.note'); commit({ ...draftRef.current, topics: { ...draftRef.current.topics, [id]: { ...draftRef.current.topics[id], note } } }); schedule(); }
  function setFocus(focus: string) { dirty.current.add('focus'); commit({ ...draftRef.current, focus }); schedule(); }

  /** Changes the outline's structure on the server after saving pending edits: an agent breakdown of one topic, or removing its sub-topics. */
  async function restructure(topic: SteerTopic, breakDown: boolean) {
    if (!editable) return;
    setError(''); setAskSimple(false); setPending(true); refocus.current = { id: topic.id, wait: breakDown, rev: Infinity };
    try {
      if (!await flush()) throw new Error('Could not save your picks. Try again.');
      if (breakDown) { const next = await api.expandTopic(job.id, topic.id); if (next.steering) { refocus.current.rev = next.steering.rev ?? 0; adopt(next.steering, true); } await onChanged(); }
      else adopt(await api.collapseTopic(job.id, topic.id), true);
    } catch (cause) {
      refocus.current = { id: topic.id, wait: false, rev: 0 };
      setError(cause instanceof Error ? cause.message : breakDown ? 'Could not break this topic down.' : 'Could not remove the sub-topics.');
    } finally { setPending(false); }
  }

  async function confirm(simple: boolean) {
    setPending(true); setError(''); setAskSimple(false); clearTimeout(timer.current);
    try {
      while (inflight.current) await inflight.current;
      await api.confirmSteering(job.id, simple ? { suggested: true } : { patch: fullPatch(draftRef.current) });
      closed.current = true; dirty.current.clear(); await onChanged();
    } catch (cause) {
      // The picks are still on the page: keep saving them, and say what went wrong.
      if (dirty.current.size) schedule();
      setError(cause instanceof Error ? cause.message : 'Could not start the lesson.');
    } finally { setPending(false); }
  }
  // "Keep it simple" throws away everything the learner added; ask first only when there is something to lose.
  const extras = plan.topics.some(topic => topic.depth > 1) || !!draft.focus.trim() || Object.values(draft.topics).some(pick => pick.note.trim());

  const counts = countPicks(plan.topics, draft.topics); const tree = buildOutlineTree(plan.topics); const cost = costLine(plan.budget, normalLinks);
  const working = job.status !== 'awaiting-input'; const expanding = /^Breaking down [“"](.*)[”"]…?$/.exec(job.stage); const hint = waitHint(job.stage);
  const sharedProps = { drafts: draft.topics, readOnly: !editable, onChoice: pickChoice, onNote: setNote, onBlur: () => void flush(), onBreak: (topic: SteerTopic) => void restructure(topic, true), onRemove: (topic: SteerTopic) => void restructure(topic, false) };
  return <div className="outline" aria-label="Research outline" role="group" ref={root}>
    <p className="outline-help">Choose how much of each topic the lesson covers. <strong>Deeper</strong> reads more about it, <strong>Summary</strong> keeps it brief, and <strong>Skip</strong> leaves it out. To choose among a topic’s parts, break it into sub-topics.</p>
    <div className="outline-working" aria-live="polite">{working && <><LoaderCircle size={14} className="spin" aria-hidden="true" /><span>{expanding ? 'Breaking down “' + expanding[1] + '”…' : job.stage}</span>{hint && <span className="outline-wait">{hint}</span>}</>}</div>
    <Nodes nodes={tree} {...sharedProps} />
    <div className="outline-focus"><label htmlFor="outline-focus">Overall focus <span>(optional)</span></label><textarea id="outline-focus" rows={2} maxLength={focusMax} disabled={!editable} placeholder="For example: I care most about how this works in practice." value={draft.focus} onChange={event => setFocus(event.target.value)} onBlur={() => void flush()} /></div>
    <div className="outline-footer"><span className="outline-counts">{countsLine(counts)}</span><span className="outline-save" aria-live="polite">{save === 'saving' ? 'Saving…' : save === 'saved' ? 'Saved' : save === 'error' ? <>Could not save · <button type="button" className="text-link" onClick={() => void flush()}>Retry</button></> : ''}</span></div>
    {error && <p className="section-error" role="alert">{error}</p>}
    <p className="outline-cost" aria-live="polite">{counts.active > 0 && <><span>{cost.main}</span> <span>{cost.normal}</span>{cost.cap && <span className="outline-cap">{cost.cap}</span>}</>}</p>
    <div className="outline-actions"><button type="button" className="primary-button" disabled={!editable || counts.active === 0} onClick={() => void confirm(false)}>{pending ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />} Build lesson</button><button type="button" className="text-link" disabled={!editable} aria-expanded={extras ? askSimple : undefined} onClick={() => extras ? setAskSimple(true) : void confirm(true)}>Keep it simple (all Summary)</button></div>
    {askSimple && editable && <div className="confirm-inline" role="group" aria-label="Confirm keep it simple"><p>Keep it simple? Every topic is covered as a Summary, and your sub-topics, notes and focus are discarded.</p><button type="button" className="primary-button" onClick={() => void confirm(true)}>Discard and build</button><button type="button" className="secondary-button" onClick={() => setAskSimple(false)}>Cancel</button></div>}
    {counts.active === 0 && <p className="stage-note">Keep at least one topic to build a lesson.</p>}
  </div>;
}
