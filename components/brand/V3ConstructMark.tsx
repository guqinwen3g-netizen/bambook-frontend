import React, { useEffect, useId, useRef } from 'react';
import { getLeafGeometry, getKnotUnderCut, markCandidates } from './mark-geometry.mjs';
import { V3BrandMark } from './V3BrandMark';
import type { V3Form, V3State } from './V3BrandMark';
export type V3Motion = 'flow'|'construct'|'orbit'|'float';
export const v3Motions: {id:V3Motion;label:string}[]=[{id:'flow',label:'光流'},{id:'construct',label:'构形'},{id:'orbit',label:'旋进'},{id:'float',label:'浮动'}];
const candidate=markCandidates.find(c=>c.code==='V3')!;
const rest=getLeafGeometry(candidate);
const folded=getLeafGeometry({...candidate,bend:.88,radius:60,tilt:76});
const number=/-?\d*\.?\d+(?:e[-+]?\d+)?/gi;
const template=rest[0].d.split(number);
const a=rest[0].d.match(number)!.map(Number), b=folded[0].d.match(number)!.map(Number);
const clamp=(v:number)=>Math.max(0,Math.min(1,v));
const ease=(v:number)=>(1-Math.cos(Math.PI*clamp(v)))/2;
const mix=(x:number,y:number,t:number)=>x+(y-x)*t;
const pathAt=(t:number)=>template.map((s:string,i:number)=>s+(i<a.length?mix(a[i],b[i],t).toFixed(3):'')).join('');
/** Separate additive motion family. The original flow renderer remains intact. */
export function V3MotionMark(props:{form?:V3Form;state?:V3State;size?:number;paused?:boolean;speed?:number;replay?:number;label?:string;motion?:V3Motion;settleToSolid?:boolean}){
 const {motion='flow',...original}=props;
 return motion==='flow'?<V3BrandMark {...original}/>:<ConstructMark {...original} motion={motion}/>;
}
function ConstructMark({form='strands',state='thinking',size=180,paused=false,speed=1,replay=0,label,motion,settleToSolid=false}: {
 form?:V3Form;state?:V3State;size?:number;paused?:boolean;speed?:number;replay?:number;label?:string;motion:V3Motion;settleToSolid?:boolean;
}){
 const svg=useRef<SVGSVGElement>(null),playback=useRef({paused,speed});playback.current={paused,speed};
 const syncPlayback=useRef<()=>void>(()=>{});
 const prefix=`v3m-${useId().replace(/:/g,'')}`;
 useEffect(()=>{
  const root=svg.current!;const media=matchMedia('(prefers-reduced-motion: reduce)');
  const rotor=root.querySelector('[data-morph-rotor]')!;
  const shape=root.querySelector('[data-morph-shape]')!;
  const groups=Array.from(root.querySelectorAll('[data-morph-leaf]'));
  const masks=Array.from(root.querySelectorAll('mask'));
  const leaves=groups.map(g=>({g,ink:g.querySelector('[data-ink]'),traces:g.querySelector('[data-traces]')!,tracePaths:Array.from(g.querySelectorAll('[data-traces] use'))}));
  const cuts=masks.map(mask=>({cut:mask.querySelector('[data-cut]')!,path:mask.querySelector('use')!}));
  const attributes=new WeakMap<Element,Map<string,string>>();
  const write=(node:Element,name:string,value:string)=>{let values=attributes.get(node);if(!values){values=new Map();attributes.set(node,values);}if(values.get(name)===value)return;node.setAttribute(name,value);values.set(name,value);};
  let elapsed=0,last:number|null=null,frame:number|null=null,visible=true,dead=false;
  const finite=state==='starting'||state==='complete'||state==='error';
  const endTime=settleToSolid?2.85:1.65;
  const active=()=>!dead&&visible&&!document.hidden&&!playback.current.paused&&!media.matches&&state!=='still'&&(!finite||elapsed<endTime);
  const render=(seconds:number)=>{
   let morph=0,draw=1,fill=1,rotation=0,floatY=0,sx=1,sy=1;
   const stopped=media.matches||state==='still';
   if(!stopped){
    const finite=state==='starting'||state==='complete'||state==='error';
    if(finite){
     const p=clamp(seconds/1.65);morph=1-ease(p);draw=ease(p/.74);fill=settleToSolid?ease((seconds-1.5)/1.2):ease((p-.45)/.5);
     if(state==='complete'){morph=.25*(1-ease(p));draw=1;fill=.5+.5*ease(p);}
     if(state==='error'){morph=0;draw=1;fill=1;}
    }else if(state==='idle'){
     morph=.07*(1-Math.cos(seconds*2*Math.PI/6))/2;
    }else{
     const cycle=state==='working'?3.8:5.2,p=(seconds%cycle)/cycle,turn=Math.floor(seconds/cycle);
     const unfold=ease(p/.32),refold=ease((p-.52)/.4);
     morph=1-unfold+refold;
     if(motion==='construct'){
      draw=p<.5?ease(p/.3):1-ease((p-.6)/.35);
      fill=ease((p-.27)/.13)*(1-ease((p-.55)/.14));
      rotation=60*(turn+ease((p-.54)/.4));
     }else if(motion==='orbit'){
      morph*=.5;rotation=60*(turn+ease((p-.15)/.62));
      sx=1-.025*Math.sin(p*Math.PI*2);sy=1+.025*Math.sin(p*Math.PI*2);
     }else{
      morph=.23+.23*Math.sin(p*Math.PI*2);floatY=-3.5*Math.sin(p*Math.PI*2);
      rotation=3*Math.sin(p*Math.PI*2);sx=1-.035*Math.sin(p*Math.PI*2);sy=1+.025*Math.sin(p*Math.PI*2);
     }
     if(state==='listening'){morph*=.5;rotation=2*Math.sin(seconds*2);draw=1;fill=1;}
    }
   }
   write(rotor,'transform',`translate(100 ${100+floatY}) rotate(${rotation}) scale(${sx} ${sy}) translate(-100 -100)`);
   write(root,'data-phase',String(Math.round((seconds%5.2)/5.2*100)));
   const d=morph===0?rest[0].d:pathAt(clamp(morph));
   write(shape,'d',d);
   const live=rest.map((leaf,i)=>({...leaf,x:mix(leaf.x,folded[i].x,morph),y:mix(leaf.y,folded[i].y,morph),rotation:mix(leaf.rotation,folded[i].rotation,morph)}));
   leaves.forEach(({g,ink,traces,tracePaths},i)=>{
    const leaf=live[i];write(g,'transform',`translate(${leaf.x} ${leaf.y}) rotate(${leaf.rotation})`);
    if(ink)write(ink,'opacity',String(form==='mist'?.12*fill:fill));
    // The draw/retract cycle starts and ends in actual empty space, not a guide silhouette.
    write(traces,'opacity',String(draw<=0?0:settleToSolid?1-fill:form==='solid'?.9*(1-fill):1));
    tracePaths.forEach((p,n)=>{
     // Inner strands start later and travel backwards during retraction.
     const progress=clamp(draw-(1-draw)*n*.045);
     write(p,'stroke-dashoffset',String(100*(1-progress)));
     write(p,'opacity',String(progress<=0?0:form==='strands'||form==='mist'?.4+n*.08:1));
    });
    write(g,'opacity',state==='error'&&!stopped?String(.65+.35*(1-ease(seconds/1.2))):'1');
   });
   cuts.forEach(({cut,path},i)=>{
    const leaf=live[i],over=live[(i+1)%6];
    write(cut,'x',String(getKnotUnderCut(leaf,over)));
    write(cut,'transform',`translate(${leaf.x} ${leaf.y}) rotate(${leaf.rotation})`);
    write(path,'transform',`translate(${over.x} ${over.y}) rotate(${over.rotation})`);
   });
  };
  const tick=(now:number)=>{
   frame=null;if(!active()){last=null;return;}
   if(last!==null)elapsed+=(finite?now-last:Math.min(now-last,60))/1000*playback.current.speed;
   last=now;
   render(finite?Math.min(elapsed,endTime):elapsed);
   if(active())frame=requestAnimationFrame(tick);else last=null;
  };
  const sync=()=>{
   if(!active()){if(frame!==null)cancelAnimationFrame(frame);frame=null;last=null;}
   else if(frame===null)frame=requestAnimationFrame(tick);
  };
  syncPlayback.current=sync;
  const observer=new IntersectionObserver(([entry])=>{visible=entry.isIntersecting;sync();});observer.observe(root);
  const reset=()=>{elapsed=0;last=null;render(0);sync();};media.addEventListener('change',reset);
  document.addEventListener('visibilitychange',sync);render(0);sync();
  return()=>{dead=true;if(frame!==null)cancelAnimationFrame(frame);syncPlayback.current=()=>{};observer.disconnect();media.removeEventListener('change',reset);document.removeEventListener('visibilitychange',sync);};
 },[form,state,motion,replay,settleToSolid]);
 useEffect(()=>{syncPlayback.current();},[paused,speed]);
 const startEmpty=motion==='construct'&&['starting','thinking','working'].includes(state);
 return <svg ref={svg} viewBox="0 0 200 200" width={size} height={size} className="bb-v3-mark" data-motion={motion} data-form={form} data-state={state} role={label?'img':undefined} aria-label={label} aria-hidden={label?undefined:true}>
  <g data-morph-rotor="true">
   <defs><path id={`${prefix}-shape`} data-morph-shape d={rest[0].d} pathLength="100"/>{rest.map((leaf,i)=>{const over=rest[(i+1)%6];return <mask key={i} id={`${prefix}-${i}`} maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200" style={{maskType:'luminance'}}><rect width="200" height="200" fill="white"/><rect data-cut="true" x={getKnotUnderCut(leaf,over)} y="-200" width="400" height="400" fill="black"/><use href={`#${prefix}-shape`} fill="black" stroke="black" strokeWidth={candidate.seam}/></mask>;})}</defs>
   {rest.map((leaf,i)=><g key={i} mask={`url(#${prefix}-${i})`}><g data-morph-leaf={i} transform={`translate(${leaf.x} ${leaf.y}) rotate(${leaf.rotation})`}>
    {(form==='solid'||form==='mist'||settleToSolid)&&<use data-ink="true" href={`#${prefix}-shape`} fill="currentColor" opacity={startEmpty?0:form==='mist'?.12:1}/>}
    <g data-traces="true" fill="none" stroke="currentColor" opacity={startEmpty?0:1} strokeDasharray="100 100" strokeDashoffset={startEmpty?100:0} strokeWidth={form==='strands'||form==='mist'?.65:1.1} strokeLinecap="round" strokeLinejoin="round">
     {(form==='strands'||form==='mist'?Array.from({length:7},(_,n)=>.28+n*.12):[1]).map((s,n)=><use key={n} href={`#${prefix}-shape`} transform={`scale(1 ${s})`} pathLength="100" opacity={form==='strands'||form==='mist'?.4+n*.08:1}/>)}
    </g>
   </g></g>)}
  </g>
 </svg>;
}
