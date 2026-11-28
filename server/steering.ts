import { z } from 'zod';
import { steerMaxTopics, type SteerChoice, type SteerPatch, type SteerTopic, type SteeringPlan } from '../shared/preparation';
import type { Settings } from '../shared/settings';
import { StoreError } from './store';

/** The pure rules of "Steer the research": outline shape, ids, link budgets and what the section writers are told. */
type Limits = Settings['research'];
type Outlined = { title: string; blurb: string };
const clamp = (text: string, max: number) => text.length > max ? text.slice(0, max - 1) + '…' : text;

/** `steering.json` as the server keeps it: the plan the page sees plus bookkeeping that never leaves the server. */
export type StoredPlan = SteeringPlan & {
  /** The choice a topic had before its breakdown was requested, put back when the breakdown fails or is stopped. */
  expanding?: { topicId: string; choice: SteerChoice };
  /** Confirmed with "use the suggested outline": the reduction is applied when the run starts, so leaving the queue loses nothing. */
  suggested?: boolean;
  /** Which topic each captured article was found for: the link research returned, and the id and final address of its source. */
  sources?: { topicId: string; link: string; sourceId: string; url?: string }[];
};
export function publicPlan(plan: StoredPlan): SteeringPlan {
  const { expanding: _expanding, suggested: _suggested, sources: _sources, ...shown } = plan;
  return { ...shown, rev: plan.rev ?? 0 };
}

/** One outline call: the first outline of a topic, or the breakdown of one of its topics. */
export const outlineSchema = z.object({ topics: z.array(z.object({ title: z.string().trim().min(1).max(80), blurb: z.string().trim().min(1).max(200) })).min(2).max(7) });
export const maxLinkLength = 2000;
const link = z.string().regex(/^https?:\/\/[^\s]+$/).describe(`A public http(s) address of at most ${maxLinkLength} characters`);
/** A found link in the form capture will fetch it, or undefined when it cannot be used (too long, or not one plain address). */
export function usableLink(found: string): string | undefined {
  const url = found.trim().replace(/[),.;]+$/, '');
  return url.length <= maxLinkLength && /^https?:\/\/[^\s<>"\]]+$/.test(url) ? url : undefined;
}
/** One research call for a branch: exactly one entry per requested topic. The caller trims each list to that topic's budget. */
export function steeredResearchSchema(topicIds: string[]) {
  return z.object({ topics: z.array(z.object({ topicId: z.enum(topicIds as [string, ...string[]]), links: z.array(link).min(1).max(8) })).length(topicIds.length) }).superRefine((found, ctx) => {
    if (new Set(found.topics.map(topic => topic.topicId)).size !== topicIds.length) ctx.addIssue({ code: 'custom', path: ['topics'], message: 'Return exactly one entry for every topicId.' });
  });
}

// The outline schema already trims and caps titles and blurbs.
const topic = (id: string, depth: number, outlined: Outlined, parentId?: string): SteerTopic =>
  ({ id, ...(parentId && { parentId }), depth, title: outlined.title, blurb: outlined.blurb, choice: 'summary' });
export function newPlan(outline: Outlined[], limits: Limits): StoredPlan {
  return withBudget({ status: 'choosing', topics: outline.slice(0, steerMaxTopics).map((item, index) => topic('t' + (index + 1), 1, item)), budget: { total: 0, planned: 0, wanted: 0 }, rev: 0 }, limits);
}
/** Puts the children right after their parent, numbered under it (`t2-1`), and never lets the outline pass the topic limit. Returns how many were added. */
export function addChildren(plan: SteeringPlan, parentId: string, outline: Outlined[]): number {
  const at = plan.topics.findIndex(item => item.id === parentId); if (at < 0) return 0;
  const parent = plan.topics[at];
  const children = outline.slice(0, Math.max(0, steerMaxTopics - plan.topics.length)).map((item, index) => topic(`${parent.id}-${index + 1}`, parent.depth + 1, item, parent.id));
  if (!children.length) return 0;
  parent.children = children.map(child => child.id); parent.choice = 'deeper';
  plan.topics.splice(at + 1, 0, ...children);
  return children.length;
}
/** Takes a topic's sub-topics (all levels) out of the outline and sets it to Summary. Returns how many were removed. */
export function removeChildren(plan: SteeringPlan, topicId: string): number {
  const parent = plan.topics.find(item => item.id === topicId); if (!parent) return 0;
  const gone = new Set<string>();
  // A parent always precedes its children in the list.
  for (const item of plan.topics) if (item.parentId && (item.parentId === topicId || gone.has(item.parentId))) gone.add(item.id);
  if (!gone.size) return 0;
  plan.topics = plan.topics.filter(item => !gone.has(item.id));
  delete parent.children; parent.choice = 'summary';
  return gone.size;
}
/** Applies learner edits in place. Unknown topic ids are refused; structure never changes. */
export function applyPatch(plan: SteeringPlan, patch: SteerPatch): void {
  const known = new Map(plan.topics.map(item => [item.id, item]));
  for (const edit of patch.topics ?? []) if (!known.has(edit.id)) throw new StoreError('This topic is not in the outline: ' + edit.id.slice(0, 40), 400);
  if (patch.focus !== undefined) { if (patch.focus) plan.focus = clamp(patch.focus, 500); else delete plan.focus; }
  for (const edit of patch.topics ?? []) {
    const target = known.get(edit.id)!;
    if (edit.choice) target.choice = edit.choice;
    if (edit.note !== undefined) { if (edit.note) target.note = clamp(edit.note, 300); else delete target.note; }
  }
}
/** The agent's own outline, untouched: every top-level topic on Summary, no focus, notes or breakdowns. */
export function suggestedPlan(plan: StoredPlan): StoredPlan {
  return { status: plan.status, topics: plan.topics.filter(item => item.depth === 1).map(({ id, depth, title, blurb }) => ({ id, depth, title, blurb, choice: 'summary' as const })), budget: plan.budget, rev: plan.rev ?? 0 };
}

/**
 * Topics the lesson covers, in display order: not skipped, under no skipped topic, and under no broken-down topic that was set
 * back to Summary. Such a topic is researched as one topic; its sub-topics stay in the outline, unused, so Deeper brings them back.
 */
export function keptTopics(plan: SteeringPlan): SteerTopic[] {
  const byId = new Map(plan.topics.map(item => [item.id, item])); const kept = new Set<string>();
  // A parent always precedes its children in the list.
  for (const item of plan.topics) {
    if (item.choice === 'skip') continue;
    if (!item.parentId || (kept.has(item.parentId) && byId.get(item.parentId)!.choice === 'deeper')) kept.add(item.id);
  }
  return plan.topics.filter(item => kept.has(item.id));
}
/** The kept topics that get links of their own: those with no kept child. */
export function researchLeaves(plan: SteeringPlan): SteerTopic[] {
  const kept = keptTopics(plan); const parents = new Set(kept.map(item => item.parentId));
  return kept.filter(item => !parents.has(item.id));
}
/**
 * Links per researched topic, in display order, before and after fitting the limit. A topic marked Deeper gets `deepLinks`;
 * every other one, at any level, gets `summaryLinks`. Over the limit, the deepest (then latest) topics give up links first, never below one.
 */
function budgets(plan: SteeringPlan, limits: Limits): { leaves: SteerTopic[]; wanted: number[]; planned: number[] } {
  const leaves = researchLeaves(plan);
  const wanted = leaves.map(leaf => leaf.choice === 'deeper' ? limits.deepLinks : limits.summaryLinks);
  const planned = [...wanted];
  let total = planned.reduce((sum, n) => sum + n, 0);
  while (total > limits.steeredMaxLinks) {
    let pick = -1;
    for (let i = 0; i < leaves.length; i++) {
      if (planned[i] <= 1) continue;
      if (pick < 0 || leaves[i].depth > leaves[pick].depth || (leaves[i].depth === leaves[pick].depth && planned[i] >= planned[pick])) pick = i;
    }
    if (pick < 0) break;
    planned[pick]--; total--;
  }
  return { leaves, wanted, planned };
}
export function linkBudgets(plan: SteeringPlan, limits: Limits): Map<string, number> {
  const { leaves, planned } = budgets(plan, limits);
  return new Map(leaves.map((leaf, index) => [leaf.id, planned[index]]));
}
export function withBudget<T extends SteeringPlan>(plan: T, limits: Limits): T {
  const { wanted, planned } = budgets(plan, limits); const sum = (list: number[]) => list.reduce((total, n) => total + n, 0);
  plan.budget = { total: limits.steeredMaxLinks, planned: sum(planned), wanted: sum(wanted) };
  return plan;
}
/** The researched top-level branches: each kept top-level topic with the topics under it that need links. */
export function branches(plan: SteeringPlan): { top: SteerTopic; leaves: SteerTopic[] }[] {
  const byId = new Map(plan.topics.map(item => [item.id, item]));
  const root = (item: SteerTopic): SteerTopic => item.parentId && byId.has(item.parentId) ? root(byId.get(item.parentId)!) : item;
  const leaves = researchLeaves(plan);
  return keptTopics(plan).filter(item => item.depth === 1).map(top => ({ top, leaves: leaves.filter(leaf => root(leaf) === top) }));
}

/**
 * The topic each captured article belongs to (source id → topic id). The record made at capture decides, by source id and then
 * by address; an article without one falls back to its place among the found links.
 */
export function sourceTopics(plan: StoredPlan, articles: { id: string; url?: string }[]): Map<string, string> {
  const leaves = new Set(researchLeaves(plan).map(leaf => leaf.id));
  const recorded = (plan.sources ?? []).filter(item => leaves.has(item.topicId));
  const found = branches(plan).flatMap(branch => branch.leaves.flatMap(leaf => (leaf.links ?? []).map(url => ({ topicId: leaf.id, link: url }))));
  const result = new Map<string, string>();
  for (const [index, article] of articles.entries()) {
    const match = recorded.find(item => item.sourceId === article.id)
      ?? (article.url ? recorded.find(item => item.url === article.url || item.link === article.url) ?? found.find(item => item.link === article.url) : undefined)
      ?? (!recorded.length && found.length === articles.length ? found[index] : undefined);
    if (match) result.set(article.id, match.topicId);
  }
  return result;
}

/** What a section writer and its reviewer are told about the topic their source was found for. */
export type TopicBrief = { title: string; coverage: 'deeper' | 'summary'; note: string | null; previous: string | null; next: string | null };
/**
 * Everything the writing steps take from a confirmed outline: the intent text, the kept outline for the summary, and each
 * article's topic. Topics that ended up with no usable article are left out of all three and named as not covered.
 */
export function steeredWriting(text: string, plan: StoredPlan, articles: { id: string; url?: string }[]) {
  const bySource = sourceTopics(plan, articles);
  const leaves = researchLeaves(plan).filter(leaf => [...bySource.values()].includes(leaf.id));
  const covered = new Set(leaves.map(leaf => leaf.id));
  const shown = shownTopics(plan, covered);
  const coverage = (item: SteerTopic) => item.choice === 'deeper' ? 'deeper' as const : 'summary' as const;
  return {
    intent: steeredIntent(text, plan, covered),
    outline: { focus: plan.focus ?? null, topics: shown.map(item => ({ title: item.title, level: item.depth, coverage: coverage(item), note: item.note ?? null, sourceIds: articles.filter(article => bySource.get(article.id) === item.id).map(article => article.id) })) },
    topicId: (sourceId: string) => { const id = bySource.get(sourceId); return id && covered.has(id) ? id : undefined; },
    /** `previous` and `next` are the neighbouring covered topics in outline order. */
    brief: (topicId: string): TopicBrief | undefined => {
      const at = leaves.findIndex(leaf => leaf.id === topicId); if (at < 0) return undefined;
      return { title: leaves[at].title, coverage: coverage(leaves[at]), note: leaves[at].note ?? null, previous: leaves[at - 1]?.title ?? null, next: leaves[at + 1]?.title ?? null };
    },
  };
}
/** Kept topics that are covered or have a covered topic under them; every kept topic when `covered` is not given. */
function shownTopics(plan: SteeringPlan, covered?: Set<string>): SteerTopic[] {
  const kept = keptTopics(plan); if (!covered) return kept;
  const byId = new Map(plan.topics.map(item => [item.id, item])); const shown = new Set<string>();
  for (const id of covered) for (let item = byId.get(id); item; item = item.parentId ? byId.get(item.parentId) : undefined) shown.add(item.id);
  return kept.filter(item => shown.has(item.id));
}

/**
 * What the section writers are told the learner wants: the original request, then the outline choices. `covered` names the
 * researched topics that have an article; the others are listed as not covered. It is learner-controlled text and must only
 * ever reach an agent inside an untrusted data value.
 */
export function steeredIntent(text: string, plan: SteeringPlan, covered?: Set<string>): string {
  const kept = keptTopics(plan); const keptIds = new Set(kept.map(item => item.id)); const byId = new Map(plan.topics.map(item => [item.id, item]));
  const shown = shownTopics(plan, covered);
  const lines = [clamp(text.trim(), 6000)];
  if (plan.focus) lines.push('', 'Overall focus chosen by the learner: ' + clamp(plan.focus, 500));
  lines.push('', 'Topics the learner chose for this lesson:');
  for (const item of shown) lines.push(`${'  '.repeat(item.depth - 1)}- ${clamp(item.title, 80)} (level ${item.depth}${item.choice === 'deeper' ? '; go deeper: give this topic more coverage' : ''})${item.note ? ' — learner note: ' + clamp(item.note, 300) : ''}`);
  const missing = covered ? researchLeaves(plan).filter(item => !covered.has(item.id)) : [];
  if (missing.length) lines.push('', 'No usable article was found for these chosen topics, so this lesson does not cover them; do not present them as covered:', ...missing.map(item => '- ' + clamp(item.title, 80)));
  const skipped = plan.topics.filter(item => item.choice === 'skip' && (!item.parentId || (keptIds.has(item.parentId) && byId.get(item.parentId)!.choice === 'deeper')));
  if (skipped.length) lines.push('', 'The learner chose to leave these topics out; do not add material about them beyond what a source section itself says:', ...skipped.map(item => '- ' + clamp(item.title, 80)));
  return clamp(lines.join('\n'), 12_000);
}
