import { expect, test } from '@playwright/test';
test('prepare controls launch the selected provider, display real session state, and stop',async({page,request})=>{
 const response=await request.post('/api/source-bundles',{data:{title:'Preparation controls test',text:'Explain latency.'}});const bundle=await response.json();
 let job:any=null;let sessions:any[]=[];
 await page.route('**/api/preparation',route=>route.fulfill({json:{jobs:job?[job]:[],sessions,providers:[{id:'codex',available:true},{id:'claude',available:true}]}}));
 await page.route('**/api/source-bundles/*/prepare',async route=>{const data=route.request().postDataJSON();job={id:'test-job',bundleId:bundle.id,title:bundle.title,provider:data.provider,status:'running',stage:'Writing the first section',completed:0,total:3,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};sessions=[{jobId:job.id,provider:data.provider,pid:1234,startedAt:new Date().toISOString()}];await route.fulfill({status:202,json:job})});
 await page.route('**/api/preparation/test-job/stop',async route=>{job={...job,status:'cancelled',stage:'Stopped · saved drafts retained'};sessions=[];await route.fulfill({json:job})});
 await page.goto('/#sources/'+bundle.id);await page.getByLabel('Preparation agent').selectOption('claude');await page.getByRole('button',{name:'Prepare lesson',exact:true}).click();
 await expect(page.getByText('Writing the first section',{exact:true})).toBeVisible();expect(job.provider).toBe('claude');await expect(page.getByRole('button',{name:'Agent sessions: 1'})).toBeVisible();
 await page.getByRole('button',{name:'Stop preparation',exact:true}).click();await expect(page.getByText('Stopped · saved drafts retained',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Agent sessions: 0'})).toBeVisible();
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
