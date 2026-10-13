// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,expect,it,vi} from 'vitest';
import {Kanban} from './patterns';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root|undefined,host:HTMLDivElement;
function mount(onMove?: (id:string,column:string)=>void){
 host=document.createElement('div');document.body.append(host);root=createRoot(host);
 act(()=>root!.render(<Kanban columns={[{id:'working',title:'制作中',color:'var(--mist-accent)',items:[{id:'a',name:'任务A'},{id:'b',name:'任务B'}]},{id:'done',title:'待出运',color:'var(--mist-ok)',items:[]}]} itemKey={item=>item.id} renderCard={item=>item.name} onMove={onMove}/>));
 const cards=host.querySelectorAll<HTMLButtonElement>('.mist-kb-card'),target=host.querySelectorAll<HTMLElement>('.mist-kb-col')[1];
 return {a:cards[0],b:cards[1],target};
}
function event(node:HTMLElement,type:string){node.dispatchEvent(new Event(type,{bubbles:true,cancelable:true}));}
afterEach(()=>{act(()=>root?.unmount());root=undefined;host?.remove();});
it('delivers a synchronous fast drag before React renders the visual drag state',()=>{
 const onMove=vi.fn(),{a,target}=mount(onMove);
 act(()=>{event(a,'dragstart');event(target,'dragover');event(target,'drop');});
 expect(onMove).toHaveBeenCalledTimes(1);expect(onMove).toHaveBeenCalledWith('a','done');expect(a.hasAttribute('data-dragging')).toBe(false);
});

it('keeps visual dragging state while sending at most one move for repeated drops',()=>{
 const onMove=vi.fn(),{a,target}=mount(onMove);
 act(()=>event(a,'dragstart'));expect(a.dataset.dragging).toBe('true');
 act(()=>{event(target,'dragover');event(target,'drop');event(target,'drop');});
 expect(onMove).toHaveBeenCalledTimes(1);expect(onMove).toHaveBeenCalledWith('a','done');expect(a.hasAttribute('data-dragging')).toBe(false);expect(target.hasAttribute('data-over')).toBe(false);
});
it('clears the immediate drag identity when a drag ends without a drop',()=>{
 const onMove=vi.fn(),{a,target}=mount(onMove);
 act(()=>{event(a,'dragstart');event(a,'dragend');event(target,'drop');});
 expect(onMove).not.toHaveBeenCalled();expect(a.hasAttribute('data-dragging')).toBe(false);
});
it('uses the most recent drag identity even when multiple starts occur before rendering',()=>{
 const onMove=vi.fn(),{a,b,target}=mount(onMove);
 act(()=>{event(a,'dragstart');event(b,'dragstart');event(target,'drop');});
 expect(onMove).toHaveBeenCalledTimes(1);expect(onMove).toHaveBeenCalledWith('b','done');
});
