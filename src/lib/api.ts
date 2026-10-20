import type { PreparationState, PreparationJob, PrepareAction, Provider } from '../../shared/preparation';
import type { SpeechRequest, SpeechAudio, SpeechStatus } from '../../shared/speech';
import type { Familiarity, Lesson, LessonSummary, Mode, Progress } from '../../shared/lesson';
import type { SourceInput, SourceBundle, BundleSummary } from '../../shared/sources';
import type { SettingsResponse } from '../../shared/settings';
import type { TutorAsk, TutorState, TutorTurn } from '../../shared/tutor';
import type { Voice } from '../../shared/speech';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch('/api' + path, options);
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => ({ error: 'The local server did not return a valid response.' }));
  if (!response.ok) throw new Error([body.error, ...(body.details ?? [])].filter(Boolean).join('\n'));
  return body as T;
}
export const api = {
  speechStatus: () => request<SpeechStatus>('/speech'),
  renderSpeech: async (input:SpeechRequest,signal:AbortSignal):Promise<SpeechAudio>=>{
    const response=await fetch('/api/speech/render',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal,cache:'no-store'});
    if(!response.ok){const body=await response.json().catch(()=>({error:'Could not prepare narration.'}));throw new Error([body.error,...(body.details??[])].filter(Boolean).join('\n'));}
    if(!response.headers.get('Content-Type')?.startsWith('audio/wav'))throw new Error('The speech server did not return audio.');
    const blob=await response.blob();signal.throwIfAborted();
    const url=URL.createObjectURL(blob);
    return {url,release:()=>URL.revokeObjectURL(url)};
  },
  tutorState: (lessonId:string,mode:Mode) => request<TutorState>('/lessons/'+encodeURIComponent(lessonId)+'/tutor?mode='+encodeURIComponent(mode)),
  askTutor: (lessonId:string,input:TutorAsk) => request<TutorTurn>('/lessons/'+encodeURIComponent(lessonId)+'/tutor/turns',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}),
  stopTutor: (turnId:string) => request<TutorTurn>('/tutor/turns/'+encodeURIComponent(turnId)+'/stop',{method:'POST'}),
  deleteTutorTurn: (turnId:string) => request<void>('/tutor/turns/'+encodeURIComponent(turnId),{method:'DELETE'}),
  renderTutorSpeech: async(input:{turnId:string;part:'question'|'answer';chunk:number;voice:Voice},signal:AbortSignal):Promise<SpeechAudio>=>{
    const response=await fetch('/api/tutor/speech/render',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal,cache:'no-store'});
    if(!response.ok){const body=await response.json().catch(()=>({error:'Could not prepare tutor narration.'}));throw new Error([body.error,...(body.details??[])].filter(Boolean).join('\n'))}
    if(!response.headers.get('Content-Type')?.startsWith('audio/wav'))throw new Error('The speech server did not return audio.');
    const blob=await response.blob();signal.throwIfAborted();const url=URL.createObjectURL(blob);return{url,release:()=>URL.revokeObjectURL(url)};
  },
  settings: () => request<SettingsResponse>('/settings'),
  saveSettings: (patch: object) => request<SettingsResponse>('/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }),
  preparation: () => request<PreparationState>('/preparation'),
  prepare: (id: string, provider: Provider, familiarity?: Familiarity, action: PrepareAction = 'continue') => request<PreparationJob>('/source-bundles/' + encodeURIComponent(id) + '/prepare', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider,familiarity,action})}),
  reveal: (slug: string) => request<void>('/library/' + encodeURIComponent(slug) + '/reveal', { method: 'POST' }),
  stopPreparation: (id: string) => request<PreparationJob>('/preparation/' + encodeURIComponent(id) + '/stop', {method:'POST'}),
  bundles: () => request<BundleSummary[]>('/source-bundles'),
  bundle: (id: string) => request<SourceBundle>('/source-bundles/' + encodeURIComponent(id)),
  retrySources: (id: string) => request<SourceBundle>('/source-bundles/' + encodeURIComponent(id) + '/retry', { method: 'POST' }),
  capture: (input: SourceInput) => request<SourceBundle>('/source-bundles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }),
  renameBundle: (id: string, title: string) => request<SourceBundle>('/source-bundles/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) }),
  deleteBundle: (id: string) => request<void>('/source-bundles/' + encodeURIComponent(id), { method: 'DELETE' }),
  renameLesson: (id: string, title: string) => request<Lesson>('/lessons/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) }),
  deleteLesson: (id: string, withSources: boolean) => request<void>('/lessons/' + encodeURIComponent(id) + (withSources ? '?sources=true' : ''), { method: 'DELETE' }),
  list: () => request<LessonSummary[]>('/lessons'),
  lesson: (id: string) => request<Lesson>('/lessons/' + encodeURIComponent(id)),
  exportLesson: (id: string) => request<Lesson>('/lessons/' + encodeURIComponent(id) + '/export'),
  progress: (id: string) => request<Progress>('/lessons/' + encodeURIComponent(id) + '/progress'),
  saveProgress: (id: string, mode: Mode, blockId: string) => request<Progress>('/lessons/' + encodeURIComponent(id) + '/progress', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, blockId }),
  }),
  import: (lesson: unknown) => request<Lesson>('/lessons', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(lesson) }),
};
export async function exportLesson(id: string) { downloadLesson(await api.exportLesson(id)); }
export function downloadLesson(lesson: Lesson) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(lesson, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = lesson.id + '.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
