import express, { type ErrorRequestHandler } from 'express';
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z, ZodError } from 'zod';
import { cliRunner, type AgentRequest, type AgentRunner } from './agent-runner';

const requestSchema=z.object({
  provider:z.enum(['codex','claude']),kind:z.enum(['author','review','summary','research','tutor']),
  prompt:z.string().min(1).max(8_000_000),schema:z.record(z.string(),z.unknown()),cwd:z.string().min(1).max(1000),
  name:z.string().regex(/^[a-zA-Z0-9._-]+$/).max(180),images:z.array(z.string().min(1).max(1200)).max(24),
  model:z.string().max(200).optional(),timeoutMs:z.number().int().min(1_000).max(60*60_000).optional(),research:z.boolean().optional(),
  multiAgent:z.boolean().optional(),reasoningEffort:z.enum(['low','medium']).optional(),
}).strict();

function inside(path:string,root:string){const candidate=resolve(path),parent=resolve(root);return candidate===parent||candidate.startsWith(parent+sep)}
function authorized(header:string|undefined,token:string){return Boolean(token)&&header===`Bearer ${token}`}

export function createAgentService(runner:AgentRunner,token:string,roots:string[]){
  if(!token)throw new Error('The agent service requires a token.');
  const app=express();app.disable('x-powered-by');app.use(express.json({limit:'16mb'}));
  app.get('/health',(req,res)=>{if(!authorized(req.get('Authorization'),token)){res.status(401).json({error:'Agent service authorization failed.'});return}res.json({status:'ok',providers:runner.available()})});
  app.post('/run',async(req,res,next)=>{
    if(!authorized(req.get('Authorization'),token)){res.status(401).json({error:'Agent service authorization failed.'});return}
    try {
      const request=requestSchema.parse(req.body) as AgentRequest;
      if(!roots.some(root=>inside(request.cwd,root)))throw new AgentServiceError('Agent job directory is outside the permitted mounts.',400);
      if(request.images.some(path=>!inside(path,request.cwd)))throw new AgentServiceError('Agent images must remain inside the job directory.',400);
      const controller=new AbortController();const cancel=()=>{if(!res.writableEnded)controller.abort()};res.on('close',cancel);
      res.setHeader('Content-Type','application/x-ndjson');res.setHeader('Cache-Control','no-store');res.flushHeaders();
      const emit=(value:unknown)=>{if(!res.writableEnded)res.write(JSON.stringify(value)+'\n')};
      try {const value=await runner.run(request,controller.signal,pid=>emit({type:'session',pid}),usage=>emit({type:'usage',usage}));emit({type:'result',value})}
      catch(error){emit({type:'error',error:error instanceof Error?error.message:'Agent job failed.'})}
      finally{res.off('close',cancel);if(!res.writableEnded)res.end()}
    } catch(error){next(error)}
  });
  const errors:ErrorRequestHandler=(error,_req,res,_next)=>{
    if(res.headersSent){res.end();return}
    if(error instanceof AgentServiceError)res.status(error.status).json({error:error.message});
    else if(error instanceof ZodError)res.status(400).json({error:'Agent request is invalid.'});
    else res.status(500).json({error:'Agent service failed.'});
  };app.use(errors);return app;
}
class AgentServiceError extends Error{constructor(message:string,readonly status:number){super(message)}}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const token=process.env.NARAD_AGENT_TOKEN;if(!token)throw new Error('NARAD_AGENT_TOKEN is required.');
  const roots=(process.env.NARAD_AGENT_ROOTS??'/data/library,/data/preparations,/data/tutor').split(',').filter(Boolean);
  const socket=process.env.NARAD_AGENT_SOCKET;
  if(socket){mkdirSync(dirname(socket),{recursive:true});if(existsSync(socket))unlinkSync(socket)}
  const port=Number(process.env.NARAD_AGENT_PORT??4320),host=process.env.NARAD_AGENT_BIND_HOST??'127.0.0.1';
  const ready=()=>{if(socket)chmodSync(socket,0o660);console.log(socket?`Narad agent service: unix:${socket}`:`Narad agent service: http://${host}:${port}`)};
  const server=socket?createAgentService(cliRunner,token,roots).listen(socket,ready):createAgentService(cliRunner,token,roots).listen(port,host,ready);
  const stop=()=>server.close(()=>{if(socket&&existsSync(socket))unlinkSync(socket);process.exit(0)});process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
