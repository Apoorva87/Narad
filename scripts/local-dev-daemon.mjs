import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const projectDir=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const child=spawn('npm',['run','dev'],{cwd:projectDir,env:process.env,stdio:'inherit',detached:true});
let stopping=false;

function signalGroup(signal){
  if(!child.pid)return;
  try{process.kill(-child.pid,signal)}catch{/* process group already exited */}
}
function stop(signal){
  if(stopping)return;stopping=true;signalGroup(signal);
  const force=setTimeout(()=>{signalGroup('SIGKILL');process.exit(1)},5000);force.unref();
}
for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,()=>stop(signal));
child.once('error',error=>{console.error('Could not start local Narad:',error.message);process.exit(1)});
child.once('exit',(code,signal)=>{if(signal&&!stopping)console.error('Local Narad stopped from signal '+signal);process.exit(code??(stopping?0:1))});
