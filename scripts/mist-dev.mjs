import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {createMistDevRunner} from '../server/scripts/mist-dev.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function probeLocalApi(){
  const listening=await new Promise(resolve=>{
    const socket=net.connect({host:'127.0.0.1',port:8082});
    const finish=value=>{socket.destroy();resolve(value);};
    socket.once('connect',()=>finish(true));
    socket.once('error',error=>finish(error.code!=='ECONNREFUSED'));
    socket.setTimeout(1500,()=>finish(true));
  });
  if(!listening)return 'free';
  try{
    const response=await fetch('http://127.0.0.1:8082/api/health',{signal:AbortSignal.timeout(1500)});
    const body=await response.json();
    return response.ok&&body.status==='ok'&&body.service==='mist-workspace'&&body.mode==='local'&&body.storage==='local-file'?'local':'occupied';
  }catch{return 'occupied';}
}

/** Own only processes started here. An existing verified local API is reused. */
export async function startMistDevelopment({probe=probeLocalApi,createRunner=createMistDevRunner,startFrontend=async()=>{
  const {createServer}=await import('vite');
  const server=await createServer({root:ROOT,configFile:path.join(ROOT,'vite.mist.config.ts')});
  try{await server.listen();return server;}catch(error){await server.close();throw error;}
},pause=wait,attempts=50}={}){
  let runner,frontend,closed=false;
  const close=async()=>{if(closed)return;closed=true;await Promise.allSettled([frontend?.close(),runner?.stop()]);};
  try{
    const initial=await probe();
    if(initial==='occupied')throw new Error('8082 已被其他服务占用；请先检查该服务。Mist 不会停止或接入它。');
    if(initial!=='local'){
      process.env.MIST_LOCAL_WORKSPACE='1';
      process.env.MIST_HOST='127.0.0.1';
      process.env.MIST_PORT='8082';
      runner=createRunner();await runner.start();
      let ready=false;
      for(let i=0;i<attempts;i++){await pause(500);if(await probe()==='local'){ready=true;break;}}
      if(!ready)throw new Error('本地 Mist 服务未能就绪；请检查上方服务日志。');
    }
    frontend=await startFrontend();
    return{close,reusedApi:initial==='local'};
  }catch(error){await close();throw error;}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  let running,stopping=false;
  const stop=()=>{stopping=true;void running?.close().finally(()=>process.exit(0));};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  void startMistDevelopment().then(async result=>{
    running=result;if(stopping){await running.close();return;}
    console.log(`[mist] ${result.reusedApi?'复用已就绪的本地服务':'独立本地服务已启动'}；无需旧库账号。`);
    console.log('[mist] 打开 http://127.0.0.1:3001/ — Ctrl+C 仅停止本次启动的服务。');
  }).catch(error=>{console.error(`[mist] ${error.message}`);process.exitCode=1;});
}
