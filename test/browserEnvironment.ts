/** Missing jsdom browser APIs only; a suite's native/local mock takes priority. */
type MediaQueryHost={matchMedia?:Window['matchMedia']};
export function installMissingMatchMedia(target:MediaQueryHost):()=>void{
  if(typeof target.matchMedia==='function')return()=>{};
  const previous=Object.getOwnPropertyDescriptor(target,'matchMedia');
  Object.defineProperty(target,'matchMedia',{configurable:true,writable:true,value:(query:string):MediaQueryList=>{
    const events=new EventTarget();
    return {matches:false,media:query,onchange:null,
      addListener:(listener:EventListener)=>events.addEventListener('change',listener),
      removeListener:(listener:EventListener)=>events.removeEventListener('change',listener),
      addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events),dispatchEvent:events.dispatchEvent.bind(events),
    } as MediaQueryList;
  }});
  return()=>{if(previous)Object.defineProperty(target,'matchMedia',previous);else delete target.matchMedia;};
}
