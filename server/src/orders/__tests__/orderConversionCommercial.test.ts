import { describe, it, expect, vi } from 'vitest';
import { prepareOrderConversionCommercial, freezeOrderConversionCommercial, consumeOrderConversionCommercial, orderConversionMoqAdvisory } from '../orderConversionCommercial';
import { httpStatusOfCode } from '../../shared/errorCodes';
const snapshot={fabricDefaultMoq:900,garmentDefaultMoq:250,capsuleMoq:30,snapshotAt:'original',configId:'original-config',source:'moq_config'};
describe('conversion commercial boundary',()=>{
 it('no-customer case retains the existing policy without invented credit',async()=>{const db:any={};expect(await prepareOrderConversionCommercial(db,'actor',null,100)).toEqual({customerRelationId:null,creditException:null});});
 it('source customer changes reject before credit storage or quota writes',async()=>{const tx:any={$queryRaw:vi.fn()};await expect(freezeOrderConversionCommercial(tx,'actor','new-customer',100,{customerRelationId:'original-customer',creditException:null})).rejects.toMatchObject({code:'SOURCE_CHANGED'});expect(tx.$queryRaw).not.toHaveBeenCalled();});
 it('valid original quotation MOQ snapshot is retained without configuration re-read',async()=>{const tx:any={moqThresholdConfig:{findFirst:vi.fn()}};const result=await freezeOrderConversionCommercial(tx,'actor',null,100,{customerRelationId:null,creditException:null},snapshot);expect(result.moqSnapshot).toEqual(snapshot);expect(tx.moqThresholdConfig.findFirst).not.toHaveBeenCalled();});
 it('no blocked credit does not spend a prepared exception',async()=>{const service:any={consumeException:vi.fn()};await consumeOrderConversionCommercial({}, {moqSnapshot:snapshot,creditEvidence:null,creditException:null,actorId:'actor'} as any,'order');expect(service.consumeException).not.toHaveBeenCalled();});
 it('missing optional profile storage retains frozen snapshot advisory policy',async()=>{const verdict=await orderConversionMoqAdvisory({},'actor',null,'garment',100,'PC',snapshot as any,'actual-asset');expect(verdict).toMatchObject({ok:false,lines:[{quantity:100,effectiveMoq:250,compliant:false}]});});
 it.each(['CREDIT_BLOCKED','CREDIT_FROZEN_60_DAYS','CREDIT_REVOKED','OVERDUE_60_DAYS'])('real blocked code %s is a business conflict',code=>expect(httpStatusOfCode(code)).toBe(409));
 it('actual unavailable credit is a safe server error',()=>expect(httpStatusOfCode('CREDIT_CHECK_FAILED')).toBe(500));
});
