import { expect, test } from '@playwright/test';
test('prepare controls launch the selected provider, display real session state, and stop',async({page,request})=>{
 const response=await request.post('/api/source-bundles',{data:{title:'Preparation controls test',text:'Explain latency.'}});const bundle=await response.json();
 let job:any=null;let sessions:any[]=[];
 await page.route('**/api/preparation',route=>route.fulfill({json:{jobs:job?[job]:[],sessions,providers:[{id:'codex',available:true},{id:'claude',available:true}]}}));
 await page.route('**/api/source-bundles/*/prepare',async route=>{const data=route.request().postDataJSON();job={id:'test-job',bundleId:bundle.id,title:bundle.title,provider:data.provider,status:'running',stage:'Writing the first section',completed:0,total:3,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};sessions=[{jobId:job.id,provider:data.provider,pid:1234,startedAt:new Date().toISOString()}];await route.fulfill({status:202,json:job})});
 await page.route('**/api/preparation/test-job/stop',async route=>{job={...job,status:'cancelled',stage:'Stopped · saved drafts retained'};sessions=[];await route.fulfill({json:job})});
 await page.goto('/#sources/'+bundle.id);await page.getByLabel('Preparation agent').selectOption('claude');await page.getByRole('button',{name:'Prepare lesson',exact:true}).click();
 await expect(page.getByText('Writing the first section',{exact:true})).toBeVisible();expect(job.provider).toBe('claude');await expect(page.getByRole('button',{name:'Agents: 1 running, 0 queued'})).toBeVisible();
 await page.getByRole('button',{name:'Stop preparation',exact:true}).click();await expect(page.getByText('Stopped · saved drafts retained',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Agents: 0 running, 0 queued'})).toBeVisible();
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('a failed topic search refreshes captured-source warnings and exposes retry',async({page,request})=>{
 const response=await request.post('/api/source-bundles',{data:{title:'Research retry test',text:'Explain a topic'}});const bundle=await response.json();let failed=false;
 const job={id:'research-job',bundleId:bundle.id,title:bundle.title,provider:'codex',status:'running',stage:'Finding sources',completed:0,total:0,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
 await page.route('**/api/preparation',route=>route.fulfill({json:{jobs:[{...job,...(failed?{status:'failed',stage:'Capture needs attention',error:'Finish source capture'}:{})}],sessions:[],providers:[{id:'codex',available:true}]}}));
 await page.route('**/api/source-bundles/'+bundle.id,route=>route.fulfill({json:failed?{...bundle,status:'needs-review',sources:[...bundle.sources,{id:'discovered',title:'Discovered source',kind:'article',url:'https://example.com',markdown:'',assets:[],warnings:['Could not capture this source'],inventory:{images:0,inlineSvg:0,tables:0,savedVisuals:0}}]}:bundle}));
 await page.goto('/#sources/'+bundle.id);await expect(page.getByText('Finding sources',{exact:true})).toBeVisible();failed=true;
 await expect(page.getByRole('button',{name:'Retry incomplete sources'})).toBeVisible({timeout:7000});
});
test('a queued lesson shows its queue position and can be removed from the queue',async({page,request})=>{
 const response=await request.post('/api/source-bundles',{data:{title:'Queued lesson test',text:'Explain queues.'}});const bundle=await response.json();
 const now=new Date().toISOString();
 const other={id:'other',bundleId:'other',slug:'other',title:'Another lesson',provider:'codex',status:'running',stage:'Writing 1/3',completed:0,total:3,createdAt:now,updatedAt:now,sections:[],folder:'/tmp/other'};
 let job:any={id:bundle.id,bundleId:bundle.id,slug:bundle.id,title:bundle.title,provider:'codex',status:'queued',stage:'Queued · position 1 of 1',queuePosition:1,queueLength:1,completed:0,total:0,createdAt:now,updatedAt:now,sections:[],folder:'/tmp/q'};
 await page.route('**/api/preparation',route=>route.fulfill({json:{jobs:[other,job],sessions:[{jobId:'other',slug:'other',provider:'codex',pid:1,startedAt:now}],providers:[{id:'codex',available:true}]}}));
 let stopped=false;await page.route('**/api/preparation/'+bundle.id+'/stop',async route=>{stopped=true;job={...job,status:'stopped',stage:'Stopped · finished sections kept',queuePosition:undefined,queueLength:undefined};await route.fulfill({json:job})});
 await page.goto('/#sources/'+bundle.id);
 await expect(page.getByText('Queued · position 1 of 1',{exact:true})).toBeVisible();
 await expect(page.getByText('Another lesson is being prepared',{exact:false})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Agents: 1 running, 1 queued'})).toBeVisible();
 await page.getByRole('button',{name:'Remove from queue'}).click();expect(stopped).toBe(true);
 await expect(page.getByText('Stopped · finished sections kept',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Continue'})).toBeEnabled();
 await expect(page.getByText('Another lesson is preparing; this one will start when a slot frees up.')).toBeVisible();
});

// --- Steer the research ---
const topic = (id: string, title: string, extra: any = {}) => ({ id, depth: 1, title, blurb: 'About ' + title.toLowerCase() + '.', choice: 'summary', ...extra });
const outlineTopics = () => [topic('t1', 'How TCP congestion control works'), topic('t2', 'Fairness between flows'), topic('t3', 'Active queue management'), topic('t4', 'Historic variants')];
async function newTopicBundle(request: any, title: string) { return (await request.post('/api/source-bundles', { data: { title, text: 'Explain TCP congestion control.' } })).json(); }
/** A fake server for one steered run: the job is whatever `fake.job` holds, and every write the page makes is recorded. */
async function fakeSteering(page: any, bundle: any, topics: any[], opts: { patchGate?: Promise<void>; budget?: any } = {}) {
  const now = new Date().toISOString();
  const fake: any = { polls: 0, patches: [] as any[], expands: [] as any[], collapses: [] as any[], confirms: [] as any[], prepares: [] as any[], stalePlan: null as any, job: { id: bundle.id, bundleId: bundle.id, slug: bundle.id, title: bundle.title, provider: 'codex', status: 'awaiting-input', stage: 'Outline ready', completed: 0, total: 0, createdAt: now, updatedAt: now, sections: [], folder: '/tmp/steer', steer: true, steering: { status: 'choosing', topics, budget: opts.budget ?? { total: 40, planned: topics.length, wanted: topics.length }, rev: 1 } } };
  // `stalePlan`, when set, is what polls carry: a copy that left the server before the page's last save.
  await page.route('**/api/preparation', (route: any) => { fake.polls++; return route.fulfill({ json: { jobs: [fake.stalePlan ? { ...fake.job, steering: fake.stalePlan } : fake.job], sessions: [], providers: [{ id: 'codex', available: true }] } }); });
  await page.route('**/api/preparation/' + bundle.id + '/steering', async (route: any) => {
    const patch = route.request().postDataJSON(); fake.patches.push(patch); if (opts.patchGate) await opts.patchGate;
    const plan = fake.job.steering; for (const edit of patch.topics ?? []) Object.assign(plan.topics.find((t: any) => t.id === edit.id), edit); if (patch.focus !== undefined) plan.focus = patch.focus;
    plan.rev++; await route.fulfill({ json: plan });
  });
  await page.route('**/api/preparation/' + bundle.id + '/steering/expand', async (route: any) => { const body = route.request().postDataJSON(); fake.expands.push(body); const t = fake.job.steering.topics.find((x: any) => x.id === body.topicId); t.choice = 'deeper'; fake.job.steering.rev++; fake.job = { ...fake.job, status: 'running', stage: 'Breaking down "' + t.title + '"' }; await route.fulfill({ status: 202, json: fake.job }); });
  await page.route('**/api/preparation/' + bundle.id + '/steering/collapse', async (route: any) => {
    const body = route.request().postDataJSON(); fake.collapses.push(body); const plan = fake.job.steering;
    plan.topics = plan.topics.filter((t: any) => !t.id.startsWith(body.topicId + '-')).map((t: any) => t.id === body.topicId ? { ...t, choice: 'summary', children: undefined } : t); plan.rev++;
    await route.fulfill({ json: plan });
  });
  await page.route('**/api/preparation/' + bundle.id + '/steering/confirm', async (route: any) => { fake.confirms.push(route.request().postDataJSON()); fake.job = { ...fake.job, status: 'queued', stage: 'Queued · position 1 of 1', queuePosition: 1, queueLength: 1, steering: { ...fake.job.steering, status: 'confirmed' } }; await route.fulfill({ status: 202, json: fake.job }); });
  await page.route('**/api/source-bundles/*/prepare', async (route: any) => { fake.prepares.push(route.request().postDataJSON()); fake.job = { ...fake.job, status: 'running', stage: 'Drawing an outline of your topic', steering: undefined }; await route.fulfill({ status: 202, json: fake.job }); });
  return fake;
}
/** The outline after t1 was broken into two sub-topics. */
const brokenDown = (choice = 'deeper') => [topic('t1', 'How TCP congestion control works', { choice, children: ['t1-1', 't1-2'] }), topic('t1-1', 'Slow start', { depth: 2, parentId: 't1' }), topic('t1-2', 'Congestion avoidance', { depth: 2, parentId: 't1' }), ...outlineTopics().slice(1)];
const card = (page: any, title: string) => page.getByRole('group', { name: 'Coverage for ' + title });
const choose = (page: any, title: string, choice: string) => card(page, title).locator('label').filter({ hasText: new RegExp('^' + choice + '$') }).click();
const radio = (page: any, title: string, choice: string) => card(page, title).getByRole('radio', { name: choice, exact: true });

test('the steer checkbox sends steer:true, defaults off, and is not offered for a bundle with an article', async ({ page, request }) => {
  const bundle = await newTopicBundle(request, 'Steer checkbox test'); let body: any = null; let job: any = null;
  await page.route('**/api/preparation', route => route.fulfill({ json: { jobs: job ? [job] : [], sessions: [], providers: [{ id: 'codex', available: true }] } }));
  await page.route('**/api/source-bundles/*/prepare', async route => { body = route.request().postDataJSON(); job = { id: bundle.id, bundleId: bundle.id, slug: bundle.id, title: bundle.title, provider: 'codex', status: 'running', stage: 'Outlining the topic', completed: 0, total: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), sections: [], folder: '/tmp/steer' }; await route.fulfill({ status: 202, json: job }); });
  await page.goto('/#sources/' + bundle.id);
  const box = page.getByRole('checkbox', { name: 'Steer the research' });
  await expect(box).not.toBeChecked(); await expect(page.getByText('Pick the topics before the lesson is written')).toBeVisible();
  await box.check(); await page.getByRole('button', { name: 'Prepare lesson', exact: true }).click();
  await expect(page.getByText('Outlining the topic', { exact: true })).toBeVisible(); expect(body.steer).toBe(true);
  await expect(box).toHaveCount(0);
  // A bundle that includes an article is not topic-only.
  const withArticle = await newTopicBundle(request, 'Steer article test');
  await page.route('**/api/source-bundles/' + withArticle.id, route => route.fulfill({ json: { ...withArticle, sources: [...withArticle.sources, { id: 'a1', title: 'An article', kind: 'article', url: 'https://example.com', markdown: 'Body', assets: [], warnings: [], inventory: { images: 0, inlineSvg: 0, tables: 0, savedVisuals: 0 } }] } }));
  job = null; await page.goto('/#sources/' + withArticle.id);
  await expect(page.getByRole('button', { name: 'Prepare lesson', exact: true })).toBeVisible(); await expect(page.getByRole('checkbox', { name: 'Steer the research' })).toHaveCount(0);
});

test('a paused run shows one card per topic; Skip and Build lesson post the picks', async ({ page, request }) => {
  const bundle = await newTopicBundle(request, 'Steer picks test'); const fake = await fakeSteering(page, bundle, outlineTopics());
  await page.goto('/#sources/' + bundle.id);
  await expect(page.getByText('Waiting for your picks', { exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: /^Coverage for / })).toHaveCount(4);
  await expect(radio(page, 'Fairness between flows', 'Summary')).toBeChecked();
  await expect(radio(page, 'Fairness between flows', 'Deeper')).toBeVisible();
  await expect(page.getByText('4 topics', { exact: true })).toBeVisible();
  await choose(page, 'Fairness between flows', 'Skip');
  await expect(page.getByText('4 topics · 1 skipped', { exact: true })).toBeVisible();
  await card(page, 'Active queue management').getByRole('button', { name: 'Add a focus for this topic' }).click();
  await page.getByLabel('Focus for Active queue management').fill('Just RED and CoDel');
  await page.getByLabel(/Overall focus/).fill('Operations view');
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 4000 });
  expect(fake.patches.length).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Build lesson' }).click();
  await expect.poll(() => fake.confirms.length).toBe(1);
  expect(fake.confirms[0]).toEqual({ patch: { focus: 'Operations view', topics: [
    { id: 't1', choice: 'summary', note: '' }, { id: 't2', choice: 'skip', note: '' }, { id: 't3', choice: 'summary', note: 'Just RED and CoDel' }, { id: 't4', choice: 'summary', note: '' }] } });
  await expect(page.getByText('Queued · position 1 of 1', { exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: /^Coverage for / })).toHaveCount(0);
});

test('Build lesson is disabled with a note when every topic is skipped', async ({ page, request }) => {
  const bundle = await newTopicBundle(request, 'Steer all skipped'); await fakeSteering(page, bundle, [topic('t1', 'Only topic')]);
  await page.goto('/#sources/' + bundle.id);
  await choose(page, 'Only topic', 'Skip');
  await expect(page.getByRole('button', { name: 'Build lesson' })).toBeDisabled();
  await expect(page.getByText('Keep at least one topic', { exact: false })).toBeVisible();
});

test('a stale poll does not overwrite an unsaved pick or a typed focus', async ({ page, request }) => {
  const bundle = await newTopicBundle(request, 'Steer stale poll'); let release: () => void = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
  const fake = await fakeSteering(page, bundle, outlineTopics(), { patchGate: gate });
  await page.goto('/#sources/' + bundle.id); await expect(page.getByRole('group', { name: /^Coverage for / })).toHaveCount(4);
  await choose(page, 'Historic variants', 'Skip'); await page.getByLabel(/Overall focus/).fill('Only the basics');
  await expect.poll(() => fake.patches.length).toBeGreaterThan(0); // the save is in flight and held by the server
  const before = fake.polls; await expect.poll(() => fake.polls, { timeout: 6000 }).toBeGreaterThan(before + 1); // two polls bring the server's older picture
  await expect(radio(page, 'Historic variants', 'Skip')).toBeChecked(); await expect(page.getByLabel(/Overall focus/)).toHaveValue('Only the basics');
  release();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await expect(radio(page, 'Historic variants', 'Skip')).toBeChecked();
});

test('a poll that left the server before a save does not revert the saved text or picks', async ({ page, request }) => {
  const bundle = await newTopicBundle(request, 'Steer rev poll'); const fake = await fakeSteering(page, bundle, outlineTopics());
  await page.goto('/#sources/' + bundle.id); await expect(page.getByRole('group', { name: /^Coverage for / })).toHaveCount(4);
  const old = JSON.parse(JSON.stringify(fake.job.steering)); // rev 1, no focus, every topic Summary
  await choose(page, 'Historic variants', 'Skip'); await page.getByLabel(/Overall focus/).fill('Only the basics');
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 4000 }); expect(fake.job.steering.rev).toBeGreaterThan(1);
  fake.stalePlan = old; const before = fake.polls; await expect.poll(() => fake.polls, { timeout: 6000 }).toBeGreaterThan(before + 1);
  await expect(page.getByLabel(/Overall focus/)).toHaveValue('Only the basics'); await expect(radio(page, 'Historic variants', 'Skip')).toBeChecked();
  await expect(page.getByText('4 topics · 1 skipped', { exact: true })).toBeVisible();
});

test('picking Deeper is only a saved pick: it never asks the agent to break the topic down', async ({ page, request }) => {
  const bundle = await newTopicBundle(request, 'Steer deeper pick'); const fake = await fakeSteering(page, bundle, outlineTopics());
  await page.goto('/#sources/' + bundle.id);
  await radio(page, 'How TCP congestion control works', 'Summary').focus(); await page.keyboard.press('ArrowLeft'); // arrowing onto Deeper
  await expect(radio(page, 'How TCP congestion control works', 'Deeper')).toBeChecked(); await expect(radio(page, 'How TCP congestion control works', 'Deeper')).toBeFocused();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 4000 });
  expect(fake.patches.at(-1)).toEqual({ topics: [{ id: 't1', choice: 'deeper' }] }); expect(fake.expands).toEqual([]);
  await expect(radio(page, 'Fairness between flows', 'Skip')).toBeEnabled(); await expect(page.getByText('4 topics · 1 deeper', { exact: true })).toBeVisible();
  await expect(page.getByRole('radiogroup')).toHaveCount(4);
});

test('Break into sub-topics shows the working state read-only, then nests the new sub-topics and returns focus', async ({ page, request }) => {
  const bundle = await newTopicBundle(request, 'Steer deeper'); const fake = await fakeSteering(page, bundle, outlineTopics());
  await page.goto('/#sources/' + bundle.id);
  await choose(page, 'Fairness between flows', 'Skip'); await expect(card(page, 'Fairness between flows').getByRole('button', { name: 'Break into sub-topics' })).toHaveCount(0); // nothing to break down in a skipped topic
  await card(page, 'How TCP congestion control works').getByRole('button', { name: 'Break into sub-topics' }).click();
  await expect.poll(() => fake.expands.length).toBe(1); expect(fake.expands[0]).toEqual({ topicId: 't1' });
  await expect(page.getByText('Breaking down “How TCP congestion control works”…', { exact: true })).toBeVisible();
  await expect(page.getByText('This usually takes about a minute.', { exact: true })).toBeVisible();
  await expect(radio(page, 'Active queue management', 'Skip')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Build lesson' })).toBeDisabled();
  fake.job = { ...fake.job, status: 'awaiting-input', stage: 'Outline ready', steering: { ...fake.job.steering, rev: fake.job.steering.rev + 1, topics: [
    { ...fake.job.steering.topics[0], children: ['t1-1', 't1-2'] }, topic('t1-1', 'Slow start', { depth: 2, parentId: 't1' }), topic('t1-2', 'Congestion avoidance', { depth: 2, parentId: 't1' }), ...fake.job.steering.topics.slice(1)] } };
  await expect(card(page, 'Slow start')).toBeVisible({ timeout: 5000 });
  await expect(card(page, 'Slow start').getByText('sub-topic', { exact: true })).toBeVisible();
  await expect(card(page, 'Slow start').locator('xpath=ancestor::li[2]').getByRole('group', { name: 'Coverage for How TCP congestion control works' })).toBeVisible();
  await expect(radio(page, 'Slow start', 'Skip')).toBeEnabled(); await expect(radio(page, 'How TCP congestion control works', 'Deeper')).toBeChecked();
  await expect(page.getByText('6 topics · 1 deeper · 1 skipped', { exact: true })).toBeVisible();
  await expect(page.getByText('This usually takes about a minute.')).toHaveCount(0);
  await expect(card(page, 'How TCP congestion control works').getByRole('button', { name: 'Remove sub-topics' })).toBeFocused();
});

test('a failed breakdown shows the error and puts the topic back at Summary', async ({ page, request }) => {
  const bundle = await newTopicBundle(request, 'Steer failed expand'); const fake = await fakeSteering(page, bundle, outlineTopics());
  await page.goto('/#sources/' + bundle.id);
  await card(page, 'Fairness between flows').getByRole('button', { name: 'Break into sub-topics' }).click();
  await expect.poll(() => fake.expands.length).toBe(1);
  fake.job = { ...fake.job, status: 'awaiting-input', stage: 'Outline ready', error: 'The agent could not break this topic down.', steering: { ...fake.job.steering, rev: fake.job.steering.rev + 1, topics: fake.job.steering.topics.map((t: any) => t.id === 't2' ? { ...t, choice: 'summary' } : t) } };
  await expect(page.getByRole('alert').filter({ hasText: 'could not break this topic down' })).toBeVisible({ timeout: 5000 });
  await expect(radio(page, 'Fairness between flows', 'Summary')).toBeChecked(); await expect(radio(page, 'Fairness between flows', 'Skip')).toBeEnabled();
  await expect(card(page, 'Fairness between flows').getByRole('button', { name: 'Break into sub-topics' })).toBeFocused();
});

test('Remove sub-topics collapses a topic back to one Summary card', async ({ page, request }) => {
  const bundle = await newTopicBundle(request, 'Steer collapse'); const fake = await fakeSteering(page, bundle, brokenDown());
  await page.goto('/#sources/' + bundle.id); await expect(page.getByRole('group', { name: /^Coverage for / })).toHaveCount(6);
  const parent = card(page, 'How TCP congestion control works');
  await expect(parent.getByRole('button', { name: 'Break into sub-topics' })).toHaveCount(0);
  await parent.getByRole('button', { name: 'Remove sub-topics' }).click();
  await expect.poll(() => fake.collapses.length).toBe(1); expect(fake.collapses[0]).toEqual({ topicId: 't1' });
  await expect(page.getByRole('group', { name: /^Coverage for / })).toHaveCount(4); await expect(card(page, 'Slow start')).toHaveCount(0);
  await expect(radio(page, 'How TCP congestion control works', 'Summary')).toBeChecked();
  await expect(parent.getByRole('button', { name: 'Break into sub-topics' })).toBeFocused();
  expect(fake.expands).toEqual([]);
});

test('a parent that is not on Deeper dims its sub-topics, and they do not count as kept topics', async ({ page, request }) => {
  const bundle = await newTopicBundle(request, 'Steer dimmed'); const fake = await fakeSteering(page, bundle, brokenDown());
  await page.goto('/#sources/' + bundle.id); await expect(page.getByText('6 topics · 1 deeper', { exact: true })).toBeVisible();
  const note = page.getByText('Not covered separately — set to Deeper to use these'); await expect(note).toHaveCount(0);
  await choose(page, 'How TCP congestion control works', 'Summary');
  await expect(note).toBeVisible(); await expect(page.locator('.outline-unused').getByRole('group', { name: /^Coverage for / })).toHaveCount(2);
  await expect(page.getByText('6 topics · 2 not used', { exact: true })).toBeVisible();
 expect(fake.expands).toEqual([]); expect(fake.collapses).toEqual([]);
  // Back to Deeper uses them again, with no agent call.
  await choose(page, 'How TCP congestion control works', 'Deeper'); await expect(note).toHaveCount(0); await expect(page.locator('.outline-unused')).toHaveCount(0); expect(fake.expands).toEqual([]);
  // Sub-topics left at Summary under skipped or switched-off parents keep nothing.
  await choose(page, 'How TCP congestion control works', 'Skip'); await expect(page.getByText('Left out with this topic — set to Deeper to use these')).toBeVisible();
  for (const title of ['Fairness between flows', 'Active queue management', 'Historic variants']) await choose(page, title, 'Skip');
  await expect(page.getByText('6 topics · 6 skipped', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Build lesson' })).toBeDisabled(); await expect(page.getByText('Keep at least one topic', { exact: false })).toBeVisible();
});

test('the reading cost sits beside Build lesson, with a calm note when the cap trims it', async ({ page, request }) => {
  const normal = (await (await request.get('/api/settings')).json()).settings.research.maxLinks;
  const bundle = await newTopicBundle(request, 'Steer cost'); const fake = await fakeSteering(page, bundle, outlineTopics(), { budget: { total: 16, planned: 6, wanted: 6 } });
  await page.goto('/#sources/' + bundle.id);
  await expect(page.getByText('About 6 articles to read', { exact: true })).toBeVisible();
  await expect(page.getByText('(a normal lesson uses up to ' + normal + ')', { exact: true })).toBeVisible();
  await expect(page.getByText('Capped at', { exact: false })).toHaveCount(0);
  fake.job = { ...fake.job, steering: { ...fake.job.steering, budget: { total: 16, planned: 16, wanted: 21 } } };
  await expect(page.getByText('About 16 articles to read', { exact: true })).toBeVisible({ timeout: 5000 });
  const cap = page.getByText('Capped at 16 — 5 fewer than you asked for', { exact: true }); await expect(cap).toBeVisible();
  await expect(page.locator('.outline-cost')).toHaveAttribute('aria-live', 'polite'); await expect(cap).not.toHaveRole('alert');
});

test('Keep it simple confirms with suggested:true, asking first only when there is something to discard', async ({ page, request }) => {
  const bundle = await newTopicBundle(request, 'Steer suggested'); const fake = await fakeSteering(page, bundle, outlineTopics());
  await page.goto('/#sources/' + bundle.id);
  await page.getByRole('button', { name: 'Keep it simple (all Summary)' }).click();
  await expect.poll(() => fake.confirms.length).toBe(1); expect(fake.confirms[0]).toEqual({ suggested: true });
  const second = await newTopicBundle(request, 'Steer suggested with notes'); const other = await fakeSteering(page, second, outlineTopics());
  await page.goto('/#sources/' + second.id);
  await page.getByLabel(/Overall focus/).fill('Operations view');
  await page.getByRole('button', { name: 'Keep it simple (all Summary)' }).click();
  await expect(page.getByText('your sub-topics, notes and focus are discarded', { exact: false })).toBeVisible(); expect(other.confirms).toEqual([]);
  await page.getByRole('button', { name: 'Cancel' }).click(); await expect(page.getByText('are discarded', { exact: false })).toHaveCount(0); expect(other.confirms).toEqual([]);
  await page.getByRole('button', { name: 'Keep it simple (all Summary)' }).click(); await page.getByRole('button', { name: 'Discard and build' }).click();
  await expect.poll(() => other.confirms.length).toBe(1); expect(other.confirms[0]).toEqual({ suggested: true });
});

test('a closed focus disclosure still shows that the topic has a note', async ({ page, request }) => {
  const bundle = await newTopicBundle(request, 'Steer note label'); await fakeSteering(page, bundle, [topic('t1', 'Only topic', { note: 'Just RED and CoDel please, nothing about the older schemes' }), topic('t2', 'Other topic')]);
  await page.goto('/#sources/' + bundle.id);
  const toggle = card(page, 'Only topic').getByRole('button', { name: 'Edit focus' }); await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click(); await expect(page.getByLabel('Focus for Only topic')).toHaveCount(0);
  await expect(card(page, 'Only topic').getByRole('button', { name: 'Focus: Just RED and CoDel please, nothing…' })).toHaveAttribute('aria-expanded', 'false');
  await expect(card(page, 'Other topic').getByRole('button', { name: 'Add a focus for this topic' })).toBeVisible();
});

test('Start over on a steered run keeps steering, and the outline step says how long it usually takes', async ({ page, request }) => {
  const bundle = await newTopicBundle(request, 'Steer start over'); const fake = await fakeSteering(page, bundle, outlineTopics());
  await page.goto('/#sources/' + bundle.id);
  await page.getByRole('button', { name: 'Start over', exact: true }).click(); await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(() => fake.prepares.length).toBe(1); expect(fake.prepares[0]).toMatchObject({ action: 'restart', steer: true });
  await expect(page.getByText('Drawing an outline of your topic', { exact: true })).toBeVisible();
  await expect(page.getByText('This usually takes about a minute.', { exact: true })).toBeVisible();
});

test('the steer checkbox is remembered in this browser', async ({ page, request }) => {
  const first = await newTopicBundle(request, 'Steer remembered one'); const second = await newTopicBundle(request, 'Steer remembered two'); let body: any = null;
  await page.route('**/api/preparation', route => route.fulfill({ json: { jobs: [], sessions: [], providers: [{ id: 'codex', available: true }] } }));
  await page.route('**/api/source-bundles/*/prepare', async route => { body = route.request().postDataJSON(); await route.fulfill({ status: 202, json: { id: second.id, bundleId: second.id, slug: second.id, title: second.title, provider: 'codex', status: 'running', stage: 'Drawing an outline of your topic', completed: 0, total: 0, createdAt: '', updatedAt: '', sections: [], folder: '/tmp/steer' } }); });
  await page.goto('/#sources/' + first.id);
  const box = page.getByRole('checkbox', { name: 'Steer the research' }); await expect(box).not.toBeChecked(); await box.check();
  await page.goto('/#sources/' + second.id); await page.reload();
  await expect(box).toBeChecked();
  await page.getByRole('button', { name: 'Prepare lesson', exact: true }).click(); await expect.poll(() => body?.steer).toBe(true);
  await page.goto('/#sources/' + first.id); await box.uncheck(); await page.reload(); await expect(box).not.toBeChecked();
});

test('a run waiting for picks shows in the sidebar, the agent list and the library, with a Choose topics link', async ({ page, request }) => {
  const bundle = await newTopicBundle(request, 'Steer waiting'); await fakeSteering(page, bundle, outlineTopics());
  await page.goto('/');
  await expect(page.getByText('Choose topics to continue')).toBeVisible();
  const agents = page.getByRole('button', { name: 'Agents: 0 running, 0 queued, 1 waiting for you' }); await expect(agents).toBeVisible();
  await agents.dispatchEvent('click'); await expect(page.getByText('waiting for your picks', { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Choose topics', exact: true }).click();
  await expect(page).toHaveURL(/#sources\//); await expect(page.getByRole('group', { name: /^Coverage for / })).toHaveCount(4);
});

test('three nesting levels fit a phone with no sideways scroll and tall tap targets', async ({ page, request }) => {
  const bundle = await newTopicBundle(request, 'Steer phone');
  await fakeSteering(page, bundle, [topic('t1', 'How TCP congestion control works end to end including a very long title that must wrap', { children: ['t1-1'] }), topic('t1-1', 'Slow start and the exponential growth of the window', { depth: 2, parentId: 't1', children: ['t1-1-1'] }), topic('t1-1-1', 'Initial window sizes', { depth: 3, parentId: 't1-1' })]);
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/#sources/' + bundle.id);
  await expect(card(page, 'Initial window sizes')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const labels = card(page, 'Slow start and the exponential growth of the window').locator('.outline-choices label');
  await expect(labels).toHaveCount(3); for (const box of await labels.evaluateAll((nodes: Element[]) => nodes.map(node => node.getBoundingClientRect().height))) expect(box).toBeGreaterThanOrEqual(40);
  await expect(card(page, 'Initial window sizes').locator('.outline-choices label')).toHaveCount(2); // no Deeper at the deepest level
});

test('a paused run whose picks were already confirmed offers Continue instead of an outline that cannot be edited', async ({ page, request }) => {
  const bundle = await newTopicBundle(request, 'Steer interrupted confirm'); const fake = await fakeSteering(page, bundle, outlineTopics());
  fake.job.steering.status = 'confirmed';
  await page.goto('/#sources/' + bundle.id);
  await expect(page.getByText('Ready to resume', { exact: true })).toBeVisible();
  await expect(page.getByText('How TCP congestion control works')).toHaveCount(0);
  await expect(page.getByText('press Continue to resume', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect.poll(() => fake.prepares.length).toBe(1);
  expect(fake.prepares[0]).toMatchObject({ action: 'continue', steer: true });
});
