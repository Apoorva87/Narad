import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Bot,
  Database,
  FileImage,
  FileText,
  Globe2,
  Headphones,
  HelpCircle,
  Link2,
  MessageCircleQuestion,
  MonitorSmartphone,
  Play,
  Server,
  ShieldCheck,
  Sparkles,
  Volume2,
} from 'lucide-react';

const journey = [
  {
    icon: Link2,
    title: 'Collect the source material',
    text: 'Add links, notes, ideas, or images. Narad captures the source text and visuals so the lesson can refer back to them.',
  },
  {
    icon: Sparkles,
    title: 'Prepare the lesson',
    text: 'Choose Codex or Claude and a familiarity level. The agent writes, reviews, and saves a quick summary, detailed walkthrough, tutor dialogue, and a course with narrated key points, check questions and teaching diagrams.',
  },
  {
    icon: BookOpen,
    title: 'Read or listen',
    text: 'Choose a mode, start narration, change voices or speed, and move between passages while the text and teaching visuals follow playback.',
  },
  {
    icon: MessageCircleQuestion,
    title: 'Ask at the point of confusion',
    text: 'Open Reply beneath a passage, ask by typing or dictation, and receive a saved answer with equations, citations, diagrams, or plots when useful.',
  },
];

export function HelpPage({ onBack }: { onBack: () => void }) {
  return <main className="help-view">
    <header className="help-heading">
      <button className="back-link" onClick={onBack}><ArrowLeft size={16} />Your library</button>
      <div className="help-title-row">
        <div>
          <h1>How Narad turns sources into understanding</h1>
          <p>Narad keeps the lesson, the voice, and the tutor in one reading flow. Most of the system runs locally on your host Mac; a browser is the window into it.</p>
        </div>
        <div className="help-mark" aria-hidden="true"><img src="/narad-mark.svg" alt="" /></div>
      </div>
    </header>

    <section className="help-section architecture-section" aria-labelledby="architecture-title">
      <div className="help-section-heading">
        <h2 id="architecture-title">The system at a glance</h2>
        <p>The blue path carries lesson data. Green marks streamed speech. Amber marks bounded agent work.</p>
      </div>
      <div className="architecture-diagram" role="img" aria-label="Narad system architecture">
        <div className="architecture-zone architecture-browser">
          <div className="architecture-zone-label"><Globe2 size={15} />In your browser</div>
          <div className="architecture-inputs">
            <span><Link2 size={15} />Links</span>
            <span><FileText size={15} />Notes</span>
            <span><FileImage size={15} />Images</span>
          </div>
          <div className="architecture-node architecture-reader">
            <MonitorSmartphone size={22} />
            <div><strong>Narad web app</strong><small>Library, reader, playback, and questions</small></div>
          </div>
        </div>

        <div className="architecture-bridge" aria-hidden="true"><span>Local JSON + streamed audio</span><ArrowRight size={22} /></div>

        <div className="architecture-zone architecture-host">
          <div className="architecture-zone-label"><ShieldCheck size={15} />On your host Mac</div>
          <div className="architecture-node architecture-api">
            <Server size={22} />
            <div><strong>Express API</strong><small>Coordinates every request and validates agent output</small></div>
          </div>
          <div className="architecture-routes" aria-hidden="true"><i /><i /><i /></div>
          <div className="architecture-services">
            <div className="architecture-node architecture-agent">
              <Bot size={20} /><div><strong>Codex or Claude</strong><small>Prepares lessons and answers questions</small></div>
            </div>
            <div className="architecture-node architecture-storage">
              <Database size={20} /><div><strong>Local lesson data</strong><small>Sources, visuals, progress, settings, and tutor threads</small></div>
            </div>
            <div className="architecture-node architecture-speech">
              <Volume2 size={20} /><div><strong>Local speech worker</strong><small>Breeze TTS 2 or Qwen3-TTS creates short-lived audio chunks</small></div>
            </div>
          </div>
        </div>
      </div>
      <p className="architecture-caption"><ShieldCheck size={16} />The host owns the data and the agent sessions. A phone or another browser can connect privately, but the lesson library and speech model remain on the Mac.</p>
    </section>

    <section className="help-section" aria-labelledby="journey-title">
      <div className="help-section-heading">
        <h2 id="journey-title">A lesson’s journey</h2>
        <p>Each stage leaves a useful result you can return to later.</p>
      </div>
      <ol className="help-journey">
        {journey.map(({ icon: Icon, title, text }, index) => <li key={title}>
          <div className="journey-index"><Icon size={19} /><span>{index + 1}</span></div>
          <div><h3>{title}</h3><p>{text}</p></div>
        </li>)}
      </ol>
    </section>

    <div className="help-columns">
      <section className="help-section help-listening" aria-labelledby="listening-title">
        <div className="help-section-heading">
          <h2 id="listening-title">While you are listening</h2>
        </div>
        <ul className="help-action-list">
          <li><Play size={18} /><div><strong>Control the lesson</strong><span>Pause, resume, change speed, switch voices, or jump to another passage.</span></div></li>
          <li><Headphones size={18} /><div><strong>Follow the explanation</strong><span>The active text scrolls into view and a relevant image stays visible during playback.</span></div></li>
          <li><HelpCircle size={18} /><div><strong>Interrupt with a question</strong><span>The lesson pauses while the tutor uses the current passage, nearby context, sources, and earlier replies.</span></div></li>
        </ul>
      </section>

      <section className="help-section help-storage" aria-labelledby="storage-title">
        <div className="help-section-heading">
          <h2 id="storage-title">What stays on the host</h2>
        </div>
        <div className="storage-ledger">
          <div><Database size={18} /><span><strong>Saved</strong>Lessons, captured visuals, reading progress, settings, preparation drafts, and tutor replies.</span></div>
          <div><Volume2 size={18} /><span><strong>Streamed</strong>Generated speech is streamed to the browser and is not saved as WAV files.</span></div>
        </div>
      </section>
    </div>

    <section className="help-section help-details" aria-labelledby="details-title">
      <div className="help-section-heading"><h2 id="details-title">Useful details</h2></div>
      <details><summary>Why can I see and stop agent sessions?</summary><p>Narad starts an app-owned Codex or Claude process when it prepares a lesson or answers a tutor question. The Agents panel shows those sessions and lets you stop one that is no longer needed.</p></details>
      <details><summary>How are formulas and diagrams handled?</summary><p>Prepared lessons store display content and spoken wording together. Original figures remain linked to their sources, while teaching diagrams and plots are stored as structured content that Narad renders safely.</p></details>
      <details><summary>What changes when I choose a familiarity level?</summary><p>The source facts stay fixed. Narad changes the vocabulary, pacing, and amount of explanation, with the detailed walkthrough preserving formulas, figures, and factual values at every level.</p></details>
      <details><summary>Can narration continue on a phone?</summary><p>Mobile Safari can expose the current lesson through lock-screen media controls after playback begins. The host Mac and speech server must remain awake and reachable.</p></details>
    </section>
  </main>;
}
