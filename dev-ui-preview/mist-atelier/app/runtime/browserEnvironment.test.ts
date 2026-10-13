// @vitest-environment jsdom
import {expect,it,vi} from 'vitest';
import {installMissingMatchMedia} from '../../../../test/browserEnvironment';

it('provides missing browser media queries with the requested media and removable modern and legacy listeners',()=>{
  const target:{matchMedia?:Window['matchMedia']}={},restore=installMissingMatchMedia(target),query=target.matchMedia!('(prefers-reduced-motion: reduce)');
  expect(query.matches).toBe(false);expect(query.media).toBe('(prefers-reduced-motion: reduce)');const modern=vi.fn(),legacy=vi.fn();
  query.addEventListener('change',modern);query.addListener(legacy);query.dispatchEvent(new Event('change'));expect(modern).toHaveBeenCalledOnce();expect(legacy).toHaveBeenCalledOnce();
  query.removeEventListener('change',modern);query.removeListener(legacy);query.dispatchEvent(new Event('change'));expect(modern).toHaveBeenCalledOnce();expect(legacy).toHaveBeenCalledOnce();restore();
});

it('preserves a suite-provided matchMedia implementation and its preferred-motion result',()=>{
  const custom=vi.fn((_query:string)=>({matches:true,media:'suite preference'} as MediaQueryList)),target={matchMedia:custom},restore=installMissingMatchMedia(target);
  expect(target.matchMedia).toBe(custom);expect(target.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);restore();expect(target.matchMedia).toBe(custom);
});

it('cleans the fallback and local replacement so the next test starts with its original browser descriptor',()=>{
  const target:{matchMedia?:Window['matchMedia']}={},restore=installMissingMatchMedia(target),first=target.matchMedia;
  target.matchMedia=vi.fn(()=>({matches:true} as MediaQueryList));restore();expect(Object.hasOwn(target,'matchMedia')).toBe(false);
  const again=installMissingMatchMedia(target);expect(target.matchMedia).not.toBe(first);expect(target.matchMedia!('screen').matches).toBe(false);again();expect(Object.hasOwn(target,'matchMedia')).toBe(false);
  const descriptor={value:undefined,writable:false,configurable:true,enumerable:false};Object.defineProperty(target,'matchMedia',descriptor);const restoreExisting=installMissingMatchMedia(target);restoreExisting();expect(Object.getOwnPropertyDescriptor(target,'matchMedia')).toEqual(descriptor);
});
