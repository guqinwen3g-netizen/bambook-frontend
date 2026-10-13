import {afterEach,beforeEach} from 'vitest';
import {installMissingMatchMedia} from './browserEnvironment';

let restore:(()=>void)|undefined;
beforeEach(()=>{restore=typeof window==='undefined'?undefined:installMissingMatchMedia(window);});
// Vitest runs afterEach in reverse registration order, after a suite's local
// mock cleanup/unmount. Restore exactly the descriptor present before the test.
afterEach(()=>{restore?.();restore=undefined;});
