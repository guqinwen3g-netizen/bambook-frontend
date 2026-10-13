import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as store from '../emailCredentialStore';
const binding={actorId:'u1',emailId:'E1',smtpUser:'sender@bambook.local',contentHash:'a'.repeat(64)};
// The RED snapshot only has the original unbound store; test its actual public
// entry points with the same required binding rather than mocking credentials.
const put = (pass:string,b:any) => ((store as any).putEmailSendCredential || store.putEmailCredential)(pass,b);
const take = (ref:string,b:any) => ((store as any).takeEmailSendCredential || store.takeEmailCredential)(ref,b);
beforeEach(()=>{vi.useRealTimers();store.clearEmailCredentials()});
describe('Send credential binding, sync compatibility',()=>{
  it.each(['actorId','emailId','smtpUser','contentHash'])('wrong %s refuses without consuming original credential',field=>{
    const ref=put('synthetic-bound-secret',binding);
    expect(take(ref,{...binding,[field]:'wrong'})).toBeNull();
    expect(take(ref,binding)).toBe('synthetic-bound-secret');expect(take(ref,binding)).toBeNull();
  });
  it('successful matching consumption is one-shot and unknown references are not credentials',()=>{
    expect(take('unknown',binding)).toBeNull();const ref=put('one-shot',binding);
    expect(take(ref,binding)).toBe('one-shot');expect(take(ref,binding)).toBeNull();
  });
  it('expiry cannot restore credentials',()=>{
    vi.useFakeTimers();const ref=put('expired',binding);vi.advanceTimersByTime(30*60*1000+1);
    expect(take(ref,binding)).toBeNull();vi.useRealTimers();
  });
  it('legacy sync credential API retains TTL, one-shot and isolation from send references',()=>{
    const sync=store.putEmailCredential('sync-secret'),send=put('send-secret',binding);
    expect(store.takeEmailCredential(send)).toBeNull();expect(store.takeEmailCredential(sync)).toBe('sync-secret');
    expect(store.takeEmailCredential(sync)).toBeNull();expect(take(send,binding)).toBe('send-secret');
    vi.useFakeTimers();const expired=store.putEmailCredential('sync-expired');vi.advanceTimersByTime(30*60*1000+1);
    expect(store.takeEmailCredential(expired)).toBeNull();vi.useRealTimers();
  });
});
