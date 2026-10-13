import React, { useEffect, useId, useRef } from 'react';
import { getKnotUnderCut, getLeafGeometry, markCandidates } from './mark-geometry.mjs';

export type V3Form = 'solid' | 'outline' | 'strands' | 'mist';
export type V3State = 'still' | 'starting' | 'idle' | 'listening' | 'thinking' | 'working' | 'complete' | 'error';
export const v3Forms: {id: V3Form; label: string}[] = [
  {id:'solid',label:'实心'}, {id:'outline',label:'轮廓'}, {id:'strands',label:'层叠细线'}, {id:'mist',label:'雾面光流'},
];
export const v3States: {id: V3State; label: string}[] = [
  {id:'still',label:'静态'}, {id:'starting',label:'启动'}, {id:'idle',label:'待机'}, {id:'listening',label:'聆听'},
  {id:'thinking',label:'思考'}, {id:'working',label:'执行'}, {id:'complete',label:'完成'}, {id:'error',label:'受阻'},
];
const candidate = markCandidates.find(mark => mark.code === 'V3')!;
const leaves = getLeafGeometry(candidate);
const smooth = 'cubic-bezier(.45,0,.25,1)';

/** V3 geometry stays fixed. Light travels through its authored leaf contours. */
export function V3BrandMark({form='solid',state='still',size=180,paused=false,speed=1,replay=0,label}: {
  form?:V3Form; state?:V3State; size?:number; paused?:boolean; speed?:number; replay?:number; label?:string;
}) {
  const root=useRef<SVGSVGElement>(null);
  const animations=useRef<Animation[]>([]);
  const inView=useRef(true);
  const playback=useRef({paused,speed});playback.current={paused,speed};
  const prefix=`v3-${useId().replace(/:/g,'')}`;
  useEffect(()=>{
    const svg=root.current;if(!svg)return;
    const media=matchMedia('(prefers-reduced-motion: reduce)');
    const stop=()=>{animations.current.forEach(a=>a.cancel());animations.current=[];};
    const start=()=>{
      stop();if(media.matches||state==='still')return;
      const animate=(node:Element,frames:Keyframe[],duration:number,delay=0,iterations:number=Infinity)=>{
        const a=node.animate(frames,{duration,delay,iterations,fill:'both',easing:smooth});animations.current.push(a);
      };
      const finite=state==='starting'||state==='complete'||state==='error';
      svg.querySelectorAll('[data-v3-leaf]').forEach((node,index)=>{
        // Opposite leaves share a beat, retaining the balanced six-leaf silhouette.
        const pair=index%3;
        if(state==='starting')animate(node,[{opacity:.12},{opacity:1}],900,index*95,1);
        else if(state==='complete')animate(node,[{opacity:.55},{opacity:1,offset:.55},{opacity:1}],1100,pair*70,1);
        else if(state==='error')animate(node,[{opacity:1},{opacity:.38,offset:.35},{opacity:.8}],850,0,1);
        else if(form==='solid')animate(node,[{opacity:1},{opacity:state==='idle'?.9:.55},{opacity:1}],state==='idle'?4800:state==='listening'?2400:3200,-pair*350);
      });
      svg.querySelectorAll('[data-v3-flow]').forEach((node,index)=>{
        const leaf=Number(node.getAttribute('data-leaf'));
        const duration=state==='working'?2600:state==='thinking'?5200:state==='listening'?3400:10000;
        if(state==='starting')animate(node,[{strokeDasharray:'0 100',opacity:0},{strokeDasharray:'100 0',opacity:.85}],1300,leaf*80,1);
        else if(state==='complete')animate(node,[{strokeDashoffset:100,opacity:0},{strokeDashoffset:0,opacity:.9,offset:.65},{strokeDashoffset:-30,opacity:0}],1500,leaf*45,1);
        else if(state==='error')animate(node,[{opacity:.6},{opacity:0}],600,0,1);
        else if(state==='listening')animate(node,[{strokeDashoffset:65,opacity:.25},{strokeDashoffset:0,opacity:1},{strokeDashoffset:65,opacity:.25}],duration,-(leaf%3)*160);
        else animate(node,[{strokeDashoffset:100},{strokeDashoffset:-100}],duration,-leaf*duration/6-index*17);
      });
      animations.current.forEach(a=>{a.playbackRate=playback.current.speed;if(playback.current.paused||document.hidden||!inView.current)a.pause();});
      // Finite status animations settle on a legible static identity.
      if(finite)svg.dataset.finite='true';else delete svg.dataset.finite;
    };
    start();media.addEventListener('change',start);
    const visibility=()=>animations.current.forEach(a=>{if(document.hidden||playback.current.paused||!inView.current)a.pause();else if(a.playState!=='finished')a.play();});
    const observer=new IntersectionObserver(([entry])=>{inView.current=entry.isIntersecting;visibility();});observer.observe(svg);
    document.addEventListener('visibilitychange',visibility);
    return()=>{observer.disconnect();stop();media.removeEventListener('change',start);document.removeEventListener('visibilitychange',visibility);};
  },[form,state,replay]);
  useEffect(()=>{animations.current.forEach(a=>{a.playbackRate=playback.current.speed;if(playback.current.paused||document.hidden||!inView.current)a.pause();else if(a.playState!=='finished')a.play();});},[paused,speed]);
  return <svg ref={root} className="bb-v3-mark" viewBox="0 0 200 200" width={size} height={size} data-form={form} data-state={state}
    role={label?'img':undefined} aria-label={label} aria-hidden={label?undefined:true}>
    <defs>{leaves.map((leaf,i)=>{const over=leaves[(i+1)%6];return <mask key={i} id={`${prefix}-${i}`} maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200" style={{maskType:'luminance'}}>
      <rect width="200" height="200" fill="white"/><rect x={getKnotUnderCut(leaf,over)} y="-200" width="400" height="400" transform={`translate(${leaf.x} ${leaf.y}) rotate(${leaf.rotation})`} fill="black"/>
      <path d={over.d} transform={`translate(${over.x} ${over.y}) rotate(${over.rotation})`} fill="black" stroke="black" strokeWidth={candidate.seam} strokeLinejoin="round"/>
    </mask>;})}</defs>
    {leaves.map((leaf,i)=><g key={i} mask={`url(#${prefix}-${i})`} data-v3-leaf={i}>
      <g transform={`translate(${leaf.x} ${leaf.y}) rotate(${leaf.rotation})`}>
        {form==='solid'&&<path d={leaf.d} fill="currentColor"/>}
        {form==='mist'&&<path d={leaf.d} fill="currentColor" opacity=".12"/>}
        {form!=='solid'&&(form==='strands'||form==='mist'?Array.from({length:7},(_,n)=>.28+n*.12):[1]).map((s,n)=><path key={n} d={leaf.d} transform={`scale(1 ${s})`} fill="none" stroke="currentColor" strokeWidth={form==='outline'?1.1:.55} opacity={form==='outline'?.72:.28+n*.065} strokeLinejoin="round"/>)}
        <g data-v3-flow="true" data-leaf={i} opacity={state==='still'?0:.8} fill="none" stroke={form==='solid'?'var(--bb-flow-ink, var(--bg-card))':'currentColor'} strokeWidth={form==='outline'?1.6:form==='solid'?1.4:.85} strokeDasharray={state==='working'?'12 88':'24 76'} strokeLinecap="round">
          {(form==='strands'||form==='mist'?Array.from({length:7},(_,n)=>.28+n*.12):[1]).map((scale,n)=><path key={n} d={leaf.d} transform={`scale(1 ${scale})`} pathLength="100"/>)}
        </g>
      </g>
    </g>)}
  </svg>;
}
