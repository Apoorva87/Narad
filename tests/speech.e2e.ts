import { test, expect, type Page } from '@playwright/test';
import { minimalLesson } from './fixture';

function wav(seconds:number) {const length=Math.floor(seconds*24000)*2;const b=Buffer.alloc(44+length);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(length,40);return b;}
async function audioFixture(page:Page,seconds=15) {
 await page.addInitScript(()=>{const Original=window.Audio;(window as any).__audio=[];window.Audio=class extends Original{constructor(src?:string){super(src);(window as any).__audio.push(this)}}});
 await page.route('**/api/speech',r=>r.fulfill({json:{state:'ready',model:'Fixture'}}));
 await page.route('**/api/speech/render',r=>r.fulfill({contentType:'audio/wav',body:wav(seconds)}));
}
test('voice host status stays visible from the library on mobile',async({page})=>{
 await audioFixture(page);await page.setViewportSize({width:390,height:844});await page.goto('/');
 const status=page.getByTestId('voice-status');await expect(status).toBeVisible();await expect(status).toContainText('Voice ready');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('publishes lock-screen controls and keeps the queue moving after the page is hidden',async({page,request})=>{
 await page.addInitScript(()=>{
  const session:any={handlers:{},metadata:null,playbackState:'none',setActionHandler(action:string,handler:()=>void){this.handlers[action]=handler}};
  Object.defineProperty(navigator,'mediaSession',{configurable:true,value:session});
  (window as any).MediaMetadata=class{constructor(data:Record<string,unknown>){Object.assign(this,data)}};
 });
 const lesson=await (await request.get('/api/lessons/gradient-descent')).json();lesson.id='media-session-copy';lesson.isSample=false;
 expect((await request.post('/api/lessons',{data:lesson})).ok()).toBe(true);
 await audioFixture(page);await page.goto('/#lesson/'+lesson.id);
 const lessonTitle=await page.locator('.reader-heading h1').innerText();
 await expect.poll(()=>page.evaluate(()=>(navigator.mediaSession as any).metadata?.album)).toBe(lessonTitle);
 expect(await page.evaluate(()=>Object.keys((navigator.mediaSession as any).handlers).sort())).toEqual(['nexttrack','pause','play','previoustrack']);
 await page.getByRole('button',{name:'Play narration',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(navigator.mediaSession as any).playbackState)).toBe('playing');
 const firstAudio=await page.evaluate(()=>(window as any).__audio.at(-1).src);
 await page.evaluate(()=>{document.dispatchEvent(new Event('visibilitychange'));(window as any).__audio.at(-1).dispatchEvent(new Event('ended'))});
 await expect.poll(()=>page.evaluate(()=>(window as any).__audio.at(-1).src)).not.toBe(firstAudio);
 const firstBlock=await page.locator('.active-block').getAttribute('id');
 await page.evaluate(()=>(navigator.mediaSession as any).handlers.nexttrack());
 await expect(page.locator('.active-block')).not.toHaveAttribute('id',firstBlock!);
});
test('local narration pauses, changes speed, seeks passages and stops when modes change',async({page})=>{
 await audioFixture(page);await page.goto('/#lesson/gradient-descent');const walkthrough=page.getByRole('tab',{name:'Detailed walkthrough'});await walkthrough.click();await expect(walkthrough).toHaveAttribute('aria-selected','true');
 await page.getByRole('button',{name:'Play narration',exact:true}).click();await expect(page.locator('.speech-state')).toContainText('Speaking');
 await page.getByLabel('Playback speed').selectOption('1.5');expect(await page.evaluate(()=>(window as any).__audio.at(-1).playbackRate)).toBe(1.35);
 await page.getByRole('button',{name:'Pause narration',exact:true}).click();expect(await page.evaluate(()=>(window as any).__audio.at(-1).paused)).toBe(true);
 await page.getByRole('button',{name:'Play narration',exact:true}).click();await expect(page.locator('.speech-state')).toContainText('Speaking');
 const before=await page.locator('.active-block').getAttribute('id');await page.getByRole('button',{name:'Next passage',exact:true}).click();await expect(page.locator('.active-block')).not.toHaveAttribute('id',before!);
 await page.getByRole('tab',{name:'Tutor dialogue'}).click();await expect(page.getByRole('button',{name:'Play narration',exact:true})).toBeVisible();expect(await page.evaluate(()=>(window as any).__audio.at(-1).paused)).toBe(true);
 await page.getByRole('button',{name:'Voice settings'}).click();await page.getByLabel('Host voice',{exact:true}).selectOption('Vivian');await page.reload();await page.getByRole('button',{name:'Voice settings'}).click();await expect(page.getByLabel('Host voice',{exact:true})).toHaveValue('Vivian');await expect(page.getByLabel('Playback speed')).toHaveValue('1.5');
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect(page.getByRole('button',{name:'Next section',exact:true})).toBeVisible();
});
test('late generation cannot start audio after a mode switch, and failures can be retried',async({page})=>{
 await audioFixture(page);let release!:()=>void;
 await page.route('**/api/speech/render',async r=>{await new Promise<void>(resolve=>release=resolve);await r.fulfill({contentType:'audio/wav',body:wav(15)}).catch(()=>{})});
 await page.goto('/#lesson/bayesian-reasoning');await page.getByRole('button',{name:'Play narration',exact:true}).click();await expect(page.locator('.speech-state')).toContainText('Preparing');await page.getByRole('tab',{name:'Tutor dialogue'}).click();release();expect(await page.evaluate(()=>(window as any).__audio.at(-1).paused)).toBe(true);
 await page.unroute('**/api/speech/render');await page.route('**/api/speech/render',r=>r.fulfill({status:503,json:{error:'Speech unavailable for this test'}}));await page.getByRole('button',{name:'Play narration',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Speech unavailable');
 await page.unroute('**/api/speech/render');await page.route('**/api/speech/render',r=>r.fulfill({contentType:'audio/wav',body:wav(15)}));await page.getByRole('button',{name:'Play narration',exact:true}).click();await expect(page.locator('.speech-state')).toContainText('Speaking');
 await page.getByRole('button',{name:'Your library',exact:true}).click();expect(await page.evaluate(()=>(window as any).__audio.every((a:HTMLAudioElement)=>a.paused))).toBe(true);
});
test('real audio completion advances the highlighted passage automatically',async({page})=>{
 await audioFixture(page,0.5);await page.goto('/#lesson/gradient-descent');await page.getByRole('tab',{name:'Detailed walkthrough'}).click();const first=await page.locator('.active-block').getAttribute('id');
 await page.getByRole('button',{name:'Play narration',exact:true}).click();await expect(page.locator('.active-block')).not.toHaveAttribute('id',first!,{timeout:10000});await page.getByRole('button',{name:'Stop narration'}).click();
});
test('playback brings the selected text and next diagram above the player on mobile',async({page,request})=>{
 await audioFixture(page);await page.setViewportSize({width:390,height:844});
 const lesson=minimalLesson();lesson.id='scroll-figures';lesson.assets=[{id:'plot',src:'/assets/gradient-landscape.svg',alt:'Test plot',caption:'A preserved plot',provenance:'source'}];
 // Use an embedded image so this fixture does not depend on an asset filename.
 lesson.assets[0].src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
 lesson.modes.walkthrough.sections[1].blocks=[{...lesson.modes.walkthrough.sections[0].blocks[0],id:'image',kind:'figure',assetId:'plot',markdown:'Here is the figure.',spokenText:'Here is the figure.'}];
 await request.post('/api/lessons',{data:lesson});await page.goto('/#lesson/'+lesson.id);
 await page.locator('#block-block-a').evaluate(el=>{el.style.marginTop='1000px'});
 await page.getByRole('button',{name:'Play narration',exact:true}).click();await expect(page.locator('.speech-state')).toContainText('Speaking');
 const visible=async(selector:string)=>page.locator(selector).evaluate(el=>{const r=el.getBoundingClientRect(),p=document.querySelector('.reading-controls')!.getBoundingClientRect();return r.top>=0&&r.bottom<=p.top-8});
 await expect.poll(()=>visible('#block-block-a')).toBe(true);
 await page.evaluate(()=>(window as any).__audio.at(-1).dispatchEvent(new Event('ended')));
 await expect(page.locator('.active-block')).toHaveAttribute('id','block-image');await expect.poll(()=>visible('#block-image figure')).toBe(true);
 await page.getByRole('button',{name:'Pause narration',exact:true}).click();await page.evaluate(()=>window.scrollTo(0,0));
 await page.getByRole('button',{name:'Play narration',exact:true}).click();await expect.poll(()=>visible('#block-image figure')).toBe(true);
 await page.getByRole('button',{name:'Stop narration',exact:true}).click();
});
for(const motion of ['reduce','no-preference'] as const)test('a long passage follows audio progress and freezes when paused: '+motion,async({page,request})=>{
 await audioFixture(page);await page.emulateMedia({reducedMotion:motion});const lesson=minimalLesson();lesson.id='scroll-long-'+motion;
 lesson.modes.walkthrough.sections[0].blocks[0].markdown=('An extended explanation with details to read as the tutor speaks.\n\n').repeat(35);
 await request.post('/api/lessons',{data:lesson});await page.goto('/#lesson/'+lesson.id);await page.getByRole('button',{name:'Play narration',exact:true}).click();await expect(page.locator('.speech-state')).toContainText('Speaking');
 await expect.poll(()=>page.locator('#block-block-a').evaluate(el=>{const top=el.getBoundingClientRect().top;return top<=64&&top>-200})).toBe(true);
 const before=await page.evaluate(()=>scrollY);
 await page.evaluate(()=>{const audio=(window as any).__audio.at(-1);audio.currentTime=8;audio.dispatchEvent(new Event('timeupdate'))});
 await expect.poll(()=>page.evaluate(()=>scrollY)).toBeGreaterThan(before+200);
 // Compositor smooth scrolling reports a position up to a frame late; let it settle before measuring the freeze.
 const settled=()=>page.evaluate(()=>new Promise<number>(resolve=>setTimeout(()=>resolve(scrollY),250)));
 await page.getByRole('button',{name:'Pause narration',exact:true}).click();const paused=await settled();
 await page.evaluate(()=>{const audio=(window as any).__audio.at(-1);audio.currentTime=12;audio.dispatchEvent(new Event('timeupdate'))});
 expect(await settled()).toBe(paused);
});
