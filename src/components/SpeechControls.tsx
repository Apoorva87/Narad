import { LoaderCircle, MonitorPlay, Pause, Play, Settings2, Square } from 'lucide-react';
import { useState } from 'react';
import { voices } from '../../shared/speech';
import type { useNarration } from '../hooks/useNarration';

export function SpeechControls({narration,disabled,dialogue,onPresent}:{narration:ReturnType<typeof useNarration>;disabled:boolean;dialogue:boolean;onPresent?:()=>void}) {
  const [settings,setSettings]=useState(false);
  const {state,preferences,server}=narration;
  const active=state.status==='playing'||state.status==='loading';
  const label=server?.state==='not-installed'?server.message:state.status==='loading'?(server?.state==='loading'?'Loading the local voice model…':'Preparing narration…'):state.status==='playing'?'Speaking · follows the passage':state.waiting?'Your turn · answer to continue':state.status==='paused'?'Paused':state.status==='ended'?'End of narration':state.status==='error'?state.error:'Listen with a local voice';
  return <div className="speech-controls">
    <div className="speech-main">
      <button className="speech-play" aria-label={active?'Pause narration':'Play narration'} disabled={disabled||server?.state==='not-installed'} onClick={narration.toggle}>
        {state.status==='loading'?<LoaderCircle size={19} className="spin"/>:active?<Pause size={19}/>:<Play size={19}/>}<span>{active?'Pause':'Listen'}</span>
      </button>
      <button className="icon-button" aria-label="Stop narration" title="Stop narration" disabled={state.status==='idle'} onClick={narration.stop}><Square size={15}/></button>
      <label className="speech-rate"><span className="sr-only">Playback speed</span><select aria-label="Playback speed" value={preferences.rate} onChange={e=>narration.updatePreferences({...preferences,rate:Number(e.target.value)})}>{[0.5,0.75,1,1.25,1.5,1.75,2].map(rate=><option key={rate} value={rate}>{rate}×</option>)}</select></label>
      <button className="icon-button" aria-label="Voice settings" aria-expanded={settings} onClick={()=>setSettings(!settings)}><Settings2 size={17}/></button>
      {onPresent&&<button className="speech-present" aria-label="Start presentation" title="Presentation mode (P)" disabled={disabled} onClick={onPresent}><MonitorPlay size={16}/><span>Present</span></button>}
      <span className={'speech-state'+(state.status==='error'?' speech-error':'')} role={state.status==='error'?'alert':'status'} title={label}>{label}</span>
    </div>
    {settings&&<div className="speech-settings">
      {(dialogue?['host','expert','narrator'] as const:['narrator'] as const).map(role=><label key={role}>{role==='narrator'?'Narrator':role==='host'?'Host voice':'Tutor voice'}<select aria-label={role==='narrator'?'Narrator voice':role==='host'?'Host voice':'Tutor voice'} value={preferences[role]} onChange={e=>narration.updatePreferences({...preferences,[role]:e.target.value})}>{voices.map(voice=><option key={voice}>{voice}</option>)}</select></label>)}
      <p>Voice changes restart the current passage. Speed changes take effect immediately.</p>
    </div>}
  </div>;
}
