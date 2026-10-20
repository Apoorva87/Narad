import type { Provider } from '../shared/preparation';
import { cliRunner, type AgentRunner } from './agent-runner';
import { LocalSpeechWorker } from './speech-worker';
import { RemoteAgentRunner } from './remote-agent-runner';
import { RemoteSpeechWorker } from './remote-speech-worker';
import type { SpeechEngine } from './speech';

type Environment=Record<string,string|undefined>;
const speechModel='Qwen3-TTS-1.7B-CustomVoice-8bit@41d3337-mlx0.6.0';

export function createRuntimeServices(env:Environment=process.env):{agent:AgentRunner;speech:SpeechEngine;bindHost:string}{
  let agent:AgentRunner=cliRunner;
  if(env.NARAD_AGENT_URL){
    if(!env.NARAD_AGENT_TOKEN)throw new Error('NARAD_AGENT_TOKEN is required with NARAD_AGENT_URL.');
    const providers=(env.NARAD_AGENT_PROVIDERS??'codex,claude').split(',').map(value=>value.trim()).filter((value):value is Provider=>value==='codex'||value==='claude');
    agent=new RemoteAgentRunner(env.NARAD_AGENT_URL,env.NARAD_AGENT_TOKEN,providers);
  }
  let speech:SpeechEngine=new LocalSpeechWorker();
  if(env.NARAD_TTS_URL){
    if(!env.NARAD_TTS_TOKEN)throw new Error('NARAD_TTS_TOKEN is required with NARAD_TTS_URL.');
    speech=new RemoteSpeechWorker(env.NARAD_TTS_URL,env.NARAD_TTS_TOKEN,speechModel);
  }
  return{agent,speech,bindHost:env.NARAD_BIND_HOST??'127.0.0.1'};
}
