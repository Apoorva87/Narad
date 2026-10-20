import { useRef, useState } from 'react';
import { ImagePlus, Link, FileText, ArrowRight, LoaderCircle, X } from 'lucide-react';
import type { SourceBundle } from '../../shared/sources';
import { familiarities, familiarityLabels, type Familiarity } from '../../shared/lesson';

export const levelHints: Record<Familiarity, string> = { foundational: 'New to this: define every term, intuition first', 'some-background': 'Know the basics: focus on mechanisms and implications', advanced: 'Expert: skip basics, go deep on trade-offs and limits' };
import { api } from '../lib/api';
import { useSettings } from '../lib/settings';
import { Modal } from './Modal';

type Upload = { name: string; data: string };
function readImage(file: File): Promise<Upload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve({ name: file.name, data: String(reader.result) });
    reader.onerror = () => reject(new Error('Could not read ' + file.name)); reader.readAsDataURL(file);
  });
}
export function AddLessonDialog({ onClose, onSaved, onImport }: { onClose: () => void; onSaved: (bundle: SourceBundle) => void; onImport: () => void }) {
  const { lessons: lessonDefaults, capture } = useSettings();
  const [title, setTitle] = useState(''); const [familiarity, setFamiliarity] = useState<Familiarity>(lessonDefaults.defaultLevel); const [text, setText] = useState(''); const [images, setImages] = useState<Upload[]>([]);
  const [busy, setBusy] = useState(false); const [reading, setReading] = useState(false); const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  async function addImages(files: File[]) {
    if (!files.length || busy || reading) return;
    setError('');
    if (images.length + files.length > capture.maxImages) { setError('Add up to ' + capture.maxImages + ' images at a time.'); return; }
    if (files.some(file => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024)) { setError('Choose PNG, JPEG, or WebP images, up to 5 MB each.'); return; }
    setReading(true);
    try {
      const additions = await Promise.all(files.map(readImage));
      if ([...images, ...additions].reduce((sum, image) => sum + image.data.length, 0) > 28 * 1024 * 1024) throw new Error('These images are too large together. Add fewer images.');
      setImages(previous => [...previous, ...additions]);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not read the images.'); }
    finally { setReading(false); if (input.current) input.current.value = ''; }
  }
  async function save() {
    setBusy(true); setError('');
    try { onSaved(await api.capture({ title, text, images, familiarity })); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not save your sources.'); }
    finally { setBusy(false); }
  }
  return <Modal title="What would you like to understand?" onClose={() => { if (!busy) onClose(); }}>
    <p className="modal-description">Start with an idea, a handful of links, or an image. You can combine them in one lesson.</p>
    <div className="input-kinds"><span><FileText size={15} />Ideas & notes</span><span><Link size={15} />Article links</span><span><ImagePlus size={15} />Images & plots</span></div>
    <form className="source-composer" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>Title (optional)<input value={title} maxLength={180} onChange={event => setTitle(event.target.value)} placeholder="Give this curiosity a name" disabled={busy} /></label>
      <label>Ideas, notes, or links<textarea value={text} maxLength={100000} onChange={event => setText(event.target.value)} disabled={busy} rows={6}
        onPaste={event => { const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); void addImages(files); } }}
        placeholder={'What are you curious about? Paste your notes or links here.\n\nFor example: Help me understand this architecture and explain the performance plots.'} /></label>
      <fieldset className="level-picker" disabled={busy}><legend>Your level</legend><div role="radiogroup">{familiarities.map(level => <label key={level} className={level === familiarity ? 'selected' : ''}><input type="radio" name="familiarity" value={level} checked={level === familiarity} onChange={() => setFamiliarity(level)} /><strong>{familiarityLabels[level]}</strong><small>{levelHints[level]}</small></label>)}</div></fieldset>
      <input ref={input} className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" multiple aria-label="Source images" disabled={busy || reading} onChange={event => void addImages(Array.from(event.target.files ?? []))} />
      <button type="button" className="image-drop" disabled={busy || reading} onClick={() => input.current?.click()} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void addImages(Array.from(event.dataTransfer.files)); }}><ImagePlus size={23} /><span><strong>{reading ? 'Reading images…' : 'Add or drop images'}</strong><small>PNG, JPEG, WebP · {capture.maxImages} images, up to 5 MB each</small></span><span className="image-drop-plus">+</span></button>
      {images.length > 0 && <div className="upload-previews">{images.map((image, index) => <div className="upload-preview" key={index}><img src={image.data} alt="" /><span>{image.name}</span><button type="button" className="icon-button" aria-label={'Remove ' + image.name} disabled={busy} onClick={() => setImages(previous => previous.filter((_image, i) => i !== index))}><X size={15} /></button></div>)}</div>}
      <div className="capture-explainer"><strong>Keep the source, then build understanding.</strong><p>We’ll save your material and capture article images, equations, and tables for review. Any missing visuals will be flagged. Preparing the tutor’s explanation comes next.</p></div>
      {error && <p className="error-box" role="alert">{error}</p>}
      {busy && <p className="capture-status" role="status"><LoaderCircle size={16} className="spin" />Saving sources and downloading visuals… Large articles can take a minute.</p>}
      <div className="composer-footer"><span>Up to {capture.maxLinks} public article links</span><button className="primary-button" type="submit" disabled={busy || reading || (!text.trim() && !images.length)}>{busy ? 'Saving…' : 'Save sources'}<ArrowRight size={16} /></button></div>
    </form>
    <div className="prepared-import"><span>Already have a Narad lesson?</span><button className="text-link" disabled={busy} onClick={onImport}>Import a prepared lesson</button></div>
  </Modal>;
}
