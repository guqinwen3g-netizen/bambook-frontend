import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';

const SERVER_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const isTestFile=file=>/\.(?:test|spec)\.ts$/.test(file);
const isTestDirectory=name=>['__tests__','tests','__mocks__'].includes(name);

/** Metadata polling is intentional: this does not depend on fs.watch or Chokidar. */
export async function snapshotMistSources(root=SERVER_ROOT){
  const files=[];
  const entries=async directory=>{try{return await fs.readdir(directory,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return[];throw error;}};
  const walk=async directory=>{for(const entry of await entries(directory)){const file=path.join(directory,entry.name);if(entry.isDirectory()&&!isTestDirectory(entry.name))await walk(file);else if(entry.isFile()&&entry.name.endsWith('.ts')&&!isTestFile(entry.name))files.push(file);}};
  await walk(path.join(root,'src/mist'));
  for(const entry of await entries(path.join(root,'src/shared')))if(entry.isFile()&&/^mist.*\.ts$/.test(entry.name)&&!isTestFile(entry.name))files.push(path.join(root,'src/shared',entry.name));
  files.push(...['.env','.env.local','package.json'].map(file=>path.join(root,file)));
  const result=new Map();
  await Promise.all(files.map(async file=>{try{const stat=await fs.stat(file,{bigint:true});if(stat.isFile())result.set(path.relative(root,file),`${stat.mtimeNs}:${stat.size}`);}catch(error){if(error.code!=='ENOENT')throw error;}}));
  return result;
}
export function mistSourcesChanged(previous,current){if(previous.size!==current.size)return true;for(const [file,signature] of previous)if(current.get(file)!==signature)return true;return false;}

function launchService(root){
  const require=createRequire(path.join(root,'package.json'));
  const cli=require.resolve('tsx/cli');
  return spawn(process.execPath,[cli,'src/mist/standalone.ts'],{cwd:root,env:process.env,stdio:'inherit'});
}

/** Injection exists for lifecycle tests; the CLI always uses the real child above. */
export function createMistDevRunner({root=SERVER_ROOT,pollMs=500,debounceMs=200,stopTimeoutMs=5000,spawnChild=()=>launchService(root),log=message=>console.log(message),warn=message=>console.error(message)}={}){
  let snapshot=new Map(),pollTimer,debounceTimer,scanPromise,restartPromise,shutdownPromise;
  let current=null,started=false,stopping=false,revision=0,launchedRevision=0,scanWarning=false;
  const clearDebounce=()=>{if(debounceTimer){clearTimeout(debounceTimer);debounceTimer=undefined;}};
  const launch=()=>{
    if(stopping)return;
    const process=spawnChild(),managed={process,closed:false,expected:false,stopPromise:null,closePromise:null};
    managed.closePromise=new Promise(resolve=>{
      process.once('close',()=>{managed.closed=true;if(current===managed)current=null;if(!managed.expected&&!stopping)warn('[mist-dev] service exited; waiting for a source change');resolve();});
      process.once('error',()=>warn('[mist-dev] service could not start; waiting for a source change'));
    });
    current=managed;launchedRevision=revision;
  };
  const stopChild=()=>{
    const managed=current;if(!managed||managed.closed)return Promise.resolve();if(managed.stopPromise)return managed.stopPromise;
    managed.expected=true;
    managed.stopPromise=(async()=>{
      try{managed.process.kill('SIGTERM');}catch{warn('[mist-dev] could not signal the managed child');}
      const timeout=setTimeout(()=>{if(!managed.closed){warn('[mist-dev] managed child did not close in 5 seconds; forcing this child to stop');try{managed.process.kill('SIGKILL');}catch{warn('[mist-dev] could not force the managed child to stop');}}},stopTimeoutMs);
      try{await managed.closePromise;}finally{clearTimeout(timeout);}
    })();
    return managed.stopPromise;
  };
  const restart=()=>{
    clearDebounce();if(stopping)return Promise.resolve();if(restartPromise)return restartPromise;
    restartPromise=(async()=>{log('[mist-dev] source change detected; restarting service');await stopChild();if(!stopping)launch();})().catch(()=>{launchedRevision=revision;warn('[mist-dev] restart failed; waiting for a source change');}).finally(()=>{restartPromise=undefined;if(!stopping&&revision>launchedRevision)scheduleRestart();});
    return restartPromise;
  };
  const scheduleRestart=()=>{if(stopping)return;clearDebounce();debounceTimer=setTimeout(()=>void restart(),debounceMs);};
  const scan=()=>{
    if(stopping||scanPromise)return scanPromise??Promise.resolve();
    scanPromise=(async()=>{try{const next=await snapshotMistSources(root);if(stopping)return;if(mistSourcesChanged(snapshot,next)){snapshot=next;revision++;scheduleRestart();}scanWarning=false;}catch{if(!scanWarning&&!stopping)warn('[mist-dev] source metadata scan failed; retrying on the next poll');scanWarning=true;}})().finally(()=>{scanPromise=undefined;});
    return scanPromise;
  };
  const start=async()=>{if(started)return;started=true;snapshot=await snapshotMistSources(root);if(stopping)return;launch();pollTimer=setInterval(()=>void scan(),pollMs);log('[mist-dev] polling Mist sources every 500ms');};
  const stop=()=>{if(shutdownPromise)return shutdownPromise;stopping=true;if(pollTimer)clearInterval(pollTimer);pollTimer=undefined;clearDebounce();shutdownPromise=(async()=>{await Promise.all([stopChild(),restartPromise??Promise.resolve(),scanPromise??Promise.resolve()]);})();return shutdownPromise;};
  return{start,stop,scan};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const runner=createMistDevRunner();
  let closing=false;
  const stop=()=>{if(closing)return;closing=true;void runner.stop().finally(()=>process.exit(0));};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  void runner.start().catch(()=>{console.error('[mist-dev] startup failed; check local source files and the tsx installation');void runner.stop().finally(()=>{process.exitCode=1;});});
}
