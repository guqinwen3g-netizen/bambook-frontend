// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {it,expect,vi} from 'vitest';
import {VerticalSteps} from './patterns';
it('reveals the current horizontal step on resize, preserves selection and removes its resize listener',()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;const host=document.createElement('div');document.body.append(host);const root=createRoot(host),select=vi.fn(),remove=vi.spyOn(window,'removeEventListener');
 try{act(()=>root.render(<VerticalSteps steps={[{id:'a',label:'基本信息'},{id:'b',label:'面料目标与规格'},{id:'c',label:'工厂与计划'}]} current="c" onSelect={select}/>));const rail=host.querySelector('.mist-vsteps') as HTMLElement,button=host.querySelector('[aria-current="step"]') as HTMLButtonElement;Object.defineProperty(rail,'scrollWidth',{value:900});Object.defineProperty(rail,'clientWidth',{value:300});rail.getBoundingClientRect=()=>({left:100,width:300} as DOMRect);button.getBoundingClientRect=()=>({left:600,width:120} as DOMRect);act(()=>window.dispatchEvent(new Event('resize')));expect(rail.scrollLeft).toBe(410);act(()=>button.click());expect(select).toHaveBeenCalledWith('c');}finally{act(()=>root.unmount());host.remove();expect(remove).toHaveBeenCalledWith('resize',expect.any(Function));remove.mockRestore();}
});
