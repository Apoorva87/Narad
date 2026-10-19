import { useRef, useState } from 'react';
import { FileUp, Download, LoaderCircle } from 'lucide-react';
import { api, downloadLesson } from '../lib/api';
import type { Lesson } from '../../shared/lesson';
import { Modal } from './Modal';

export function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: (lesson: Lesson) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function read(file?: File) {
    if (!file) return;
    setError('');
    if (file.size > 12 * 1024 * 1024) { setError('Choose a lesson file smaller than 12 MB.'); return; }
    setBusy(true);
    try {
      let document: unknown;
      try { document = JSON.parse(await file.text()); } catch { throw new Error('This file is not valid JSON. Choose a prepared Narad lesson.'); }
      const lesson = await api.import(document); onImported(lesson);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not import this lesson.'); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  }
  async function example() {
    try { downloadLesson(await api.lesson('bayesian-reasoning')); } catch { setError('Could not download the example. Check the local server.'); }
  }
  return <Modal title="Add a prepared lesson" onClose={onClose}>
    <p className="modal-description">Bring a saved Narad lesson into your library. Its explanations, source snapshots, and embedded images stay together.</p>
    <input ref={input} type="file" accept=".json,application/json" className="sr-only" aria-label="Lesson JSON file" onChange={event => void read(event.target.files?.[0])} disabled={busy} />
    <button className="upload-area" disabled={busy} onClick={() => input.current?.click()}>
      {busy ? <LoaderCircle className="spin" size={30} /> : <FileUp size={30} />}
      <strong>{busy ? 'Checking your lesson…' : 'Choose a lesson file'}</strong><span>JSON format · up to 12 MB</span>
    </button>
    {error && <div className="error-box" role="alert">{error}</div>}
    <button className="text-link" onClick={() => void example()}><Download size={15} />Download an example lesson</button>
    <p className="stage-note">To start with ideas, images, or article links, choose Add a lesson. This option is for importing an already prepared Narad lesson.</p>
  </Modal>;
}
