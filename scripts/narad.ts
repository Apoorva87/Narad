import { readFile } from 'node:fs/promises';
const [command,arg,provider='codex']=process.argv.slice(2);
const base=process.env.NARAD_API_URL??'http://127.0.0.1:4318';
let path:string;let method='GET';let body:string|undefined;
switch(command){
 case 'status':path='/api/preparation';break;
 case 'add':if(!arg)throw new Error('Usage: narad add input.json');path='/api/source-bundles';method='POST';body=await readFile(arg,'utf8');JSON.parse(body);break;
 case 'prepare':if(!arg)throw new Error('Usage: narad prepare <bundle-id> [codex|claude]');path='/api/source-bundles/'+encodeURIComponent(arg)+'/prepare';method='POST';body=JSON.stringify({provider});break;
 case 'stop':if(!arg)throw new Error('Usage: narad stop <job-id>');path='/api/preparation/'+encodeURIComponent(arg)+'/stop';method='POST';break;
 default:console.log('Usage: node --import tsx scripts/narad.ts status | add input.json | prepare <bundle-id> [codex|claude] | stop <job-id>');process.exit(command?1:0);
}
const response=await fetch(base+path,{method,headers:body?{'Content-Type':'application/json'}:undefined,body});const result=await response.json();console.log(JSON.stringify(result,null,2));if(!response.ok)process.exitCode=1;
