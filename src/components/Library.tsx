import { useState } from 'react';
import { Search, ArrowUpRight, BookOpen, FilePlus2, Layers3 } from 'lucide-react';
import type { LessonSummary } from '../../shared/lesson';
import { modeLabels } from '../../shared/lesson';

export function Library({ lessons, onOpen, onImport }: { lessons: LessonSummary[]; onOpen: (id: string) => void; onImport: () => void }) {
  const [query, setQuery] = useState('');
  const filtered = lessons.filter(lesson => (lesson.title + ' ' + lesson.description + ' ' + lesson.topic).toLowerCase().includes(query.toLowerCase()));
  return <div className="library-view">
    <div className="library-heading"><div><p className="intro-label">A little curiosity, a deeper understanding.</p><h1>Your learning library</h1><p className="page-description">Keep the ideas. Understand the details. Go at your own pace.</p></div>
      <button className="primary-button" onClick={onImport}><FilePlus2 size={17} />Add a lesson</button></div>
    <div className="library-tools"><div className="collection-label"><BookOpen size={18} /><h2>All analyses</h2><span className="count">{lessons.length}</span></div>
      <label className="search"><Search size={17} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a topic or lesson…" aria-label="Search lessons" /></label></div>
    <div className="lesson-grid">
      {filtered.map(lesson => <button className="lesson-card" key={lesson.id} onClick={() => onOpen(lesson.id)}>
        <div className={'lesson-art ' + (lesson.topic === 'Probability' ? 'art-bayes' : 'art-gradient')}>
          {lesson.topic === 'Probability'
            ? <div className="bayes-art" aria-hidden="true"><span className="prior-circle">Prior</span><span className="evidence-line">+ evidence</span><span className="posterior-circle">Posterior</span></div>
            : <svg viewBox="0 0 480 180" aria-hidden="true"><path d="M75 35Q215 265 390 40" fill="none" stroke="#5b7aa6" strokeWidth="2.5"/><path d="M363 68L330 104L294 132" fill="none" stroke="#264fc5" strokeWidth="3"/><circle cx="363" cy="68" r="6" fill="#264fc5"/><circle cx="330" cy="104" r="5" fill="#264fc5"/><circle cx="294" cy="132" r="4" fill="#264fc5"/></svg>}
          <span className="topic-tag">{lesson.topic}</span>
        </div>
        <div className="lesson-card-body"><div className="card-title-row"><h3>{lesson.title}</h3><ArrowUpRight size={21} /></div><p>{lesson.description}</p>
          <div className="card-modes">{lesson.availableModes.map(mode => <span key={mode}>{modeLabels[mode]}</span>)}</div>
          <div className="card-footer"><span><Layers3 size={14} />{lesson.sourceCount} {lesson.sourceCount === 1 ? 'source' : 'sources'}</span><span>{lesson.isSample ? 'Sample lesson' : 'Imported lesson'}</span></div>
        </div>
      </button>)}
    </div>
    {!filtered.length && <div className="empty-state"><Search size={26} /><h3>{query ? 'No matching lessons' : 'Your next idea belongs here'}</h3><p>{query ? 'Try a different topic or clear your search.' : 'Add a prepared lesson to start your library.'}</p>{query && <button className="secondary-button" onClick={() => setQuery('')}>Clear search</button>}</div>}
    <div className="library-footnote"><span className="small-mark">N</span><p>{lessons.some(lesson => lesson.isSample) ? 'The sample lessons are original teaching notes, with worked mathematics and diagrams. Open one to explore the reader.' : 'Your lessons and reading positions are saved on this Mac.'}</p></div>
  </div>;
}
