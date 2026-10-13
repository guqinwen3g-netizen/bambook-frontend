import test from 'node:test';
import assert from 'node:assert/strict';
import {startMistDevelopment} from './mist-dev.mjs';

function setup(states,frontendError){
  const calls=[];
  return{calls,options:{probe:async()=>states.length>1?states.shift():states[0],pause:async()=>{},attempts:2,
    createRunner:()=>({start:async()=>calls.push('api-start'),stop:async()=>calls.push('api-stop')}),
    startFrontend:async()=>{calls.push('ui-start');if(frontendError)throw frontendError;return{close:async()=>calls.push('ui-stop')};}
  }};
}
test('cold start waits for local API before opening the frontend and closes owned services',async()=>{
  const s=setup(['free','free','local']);const running=await startMistDevelopment(s.options);
  assert.equal(running.reusedApi,false);assert.deepEqual(s.calls,['api-start','ui-start']);
  await running.close();await running.close();assert.deepEqual(s.calls,['api-start','ui-start','ui-stop','api-stop']);
});
test('reuse only a verified local API and leave it running on exit',async()=>{
  const s=setup(['local']);const running=await startMistDevelopment(s.options);await running.close();
  assert.equal(running.reusedApi,true);assert.deepEqual(s.calls,['ui-start','ui-stop']);
});
test('do not start or stop an unrelated API occupying 8082',async()=>{
  const s=setup(['occupied']);await assert.rejects(startMistDevelopment(s.options),/8082/);assert.deepEqual(s.calls,[]);
});
test('API startup timeout closes owned runner and never starts the frontend',async()=>{
  const s=setup(['free']);await assert.rejects(startMistDevelopment(s.options),/未能就绪/);assert.deepEqual(s.calls,['api-start','api-stop']);
});
test('frontend port conflict closes owned API but leaves a reused API untouched',async()=>{
  const own=setup(['free','local'],new Error('Port 3001 is already in use'));
  await assert.rejects(startMistDevelopment(own.options),/3001/);assert.deepEqual(own.calls,['api-start','ui-start','api-stop']);
  const reused=setup(['local'],new Error('Port 3001 is already in use'));
  await assert.rejects(startMistDevelopment(reused.options),/3001/);assert.deepEqual(reused.calls,['ui-start']);
});
