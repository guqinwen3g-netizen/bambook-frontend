import { describe, expect, it, vi } from 'vitest';
import { assertDevelopmentOperationalWrite as guard } from '../developmentOperationalGuard';
function db(event: any = null) {
 return { $queryRaw: vi.fn(async () => [{id:'d'}]), developmentLifecycleEvent: {findFirst:vi.fn(async()=>event)} };
}
describe('development operational lifecycle guard',()=>{
 it('allows existing cases without fabricated lifecycle records',async()=>{
  const tx=db();expect(await guard(tx,'d','stage')).toBeNull();
  expect(tx.developmentLifecycleEvent.findFirst).toHaveBeenCalledWith({where:{developmentCaseId:'d'},orderBy:{revision:'desc'}});
 });
 it.each(['update','stage','sample','convert'] as const)('blocks paused and closed %s',async operation=>{
  await expect(guard(db({state:'paused'}),'d',operation)).rejects.toMatchObject({code:'DEVELOPMENT_PAUSED',status:409});
  await expect(guard(db({state:'closed'}),'d',operation)).rejects.toMatchObject({code:'DEVELOPMENT_CLOSED',status:409});
 });
 it('completed closure permits downstream handoff, but not design edits or stopped-case handoff',async()=>{
  expect(await guard(db({state:'closed',outcome:'completed'}),'d','convert')).toMatchObject({outcome:'completed'});
  await expect(guard(db({state:'closed',outcome:'completed'}),'d','sample')).rejects.toMatchObject({code:'DEVELOPMENT_CLOSED'});
  await expect(guard(db({state:'closed',outcome:'stopped'}),'d','convert')).rejects.toMatchObject({code:'DEVELOPMENT_CLOSED'});
 });
 it('resumed case can advance but history cannot be deleted',async()=>{
  expect(await guard(db({state:'active',revision:2}),'d','update')).toMatchObject({revision:2});
  await expect(guard(db({state:'active',revision:2}),'d','delete')).rejects.toMatchObject({code:'LIFECYCLE_HISTORY_EXISTS'});
 });
 it('looks up lifecycle only after acquiring the case lock',async()=>{
  const tx=db();tx.$queryRaw.mockImplementation(async()=>{expect(tx.developmentLifecycleEvent.findFirst).not.toHaveBeenCalled();return [{id:'d'}];});await guard(tx,'d','stage');
 });
 it('missing case and failed lookup never silently become active',async()=>{
  const tx=db();tx.$queryRaw.mockResolvedValue([]);await expect(guard(tx,'d','stage')).rejects.toMatchObject({code:'NOT_FOUND'});
  const failed=db();failed.developmentLifecycleEvent.findFirst.mockRejectedValue(new Error('database unavailable'));await expect(guard(failed,'d','stage')).rejects.toThrow('database unavailable');
 });
 it('unknown stored state fails closed',async()=>{await expect(guard(db({state:'invalid'}),'d','stage')).rejects.toMatchObject({code:'INVALID_LIFECYCLE_STATE'});});
});
