import { useEffect, useState } from 'react';
import type { SpeechStatus } from '../../shared/speech';
import { api } from '../lib/api';
import './voice-status.css';

type DisplayStatus = SpeechStatus | { state: 'unreachable'; model: string; message: string };

const labels: Record<DisplayStatus['state'], string> = {
  'not-installed': 'Voice not installed',
  idle: 'Voice available',
  loading: 'Voice starting',
  ready: 'Voice ready',
  generating: 'Voice working',
  error: 'Voice needs attention',
  unreachable: 'Voice host unavailable',
};

export function VoiceStatus() {
  const [status, setStatus] = useState<DisplayStatus>();
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await api.speechStatus();
        if (active) setStatus(next);
      } catch {
        if (active) setStatus({ state: 'unreachable', model: 'Local speech', message: 'Cannot reach the voice host.' });
      } finally {
        if (active) timer = setTimeout(refresh, 5000);
      }
    };
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, []);

  const state = status?.state ?? 'loading';
  const label = status ? labels[status.state] : 'Checking voice';
  const title = status?.message || (state === 'idle' ? 'The voice model will start automatically when you press Listen.' : label);
  return <div className={'voice-status voice-status-' + state} data-testid="voice-status" role="status" aria-label={'Voice status: ' + label} title={title}>
    <span className="voice-status-dot" aria-hidden="true" />
    <span>{label}</span>
  </div>;
}
