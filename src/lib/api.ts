import type { Lesson, LessonSummary, Mode, Progress } from '../../shared/lesson';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch('/api' + path, options);
  const body = await response.json().catch(() => ({ error: 'The local server did not return a valid response.' }));
  if (!response.ok) throw new Error([body.error, ...(body.details ?? [])].filter(Boolean).join('\n'));
  return body as T;
}
export const api = {
  list: () => request<LessonSummary[]>('/lessons'),
  lesson: (id: string) => request<Lesson>('/lessons/' + encodeURIComponent(id)),
  progress: (id: string) => request<Progress>('/lessons/' + encodeURIComponent(id) + '/progress'),
  saveProgress: (id: string, mode: Mode, blockId: string) => request<Progress>('/lessons/' + encodeURIComponent(id) + '/progress', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, blockId }),
  }),
  import: (lesson: unknown) => request<Lesson>('/lessons', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(lesson) }),
};
export function downloadLesson(lesson: Lesson) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(lesson, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = lesson.id + '.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
