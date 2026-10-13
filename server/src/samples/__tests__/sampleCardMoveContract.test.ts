import{describe,it,expect}from'vitest';import{parseSampleCardMoveInput,sampleCardMoveCommand,sampleCardMoveReceiptId}from'../sampleCardMoveContract';
const good=()=>({moveVersion:1,requestKey:'move-test-0001',expectedUpdatedAt:'123',expectedCustodyFingerprint:'a'.repeat(64),targetWarehouseId:'W2',targetLocation:'B-01',occurredDate:'2026-10-04',reason:null});
describe('strict whole-card move contract',()=>{
 it('preserves full normalized input and binds actor/card/complete input',()=>{const a=parseSampleCardMoveInput(good());expect(a).toEqual(good());expect(sampleCardMoveCommand('U','C',a)).toMatchObject({operation:'move_sample_card',actorId:'U',cardId:'C',input:a});expect(sampleCardMoveReceiptId('U',a.requestKey)).not.toBe(sampleCardMoveReceiptId('OTHER',a.requestKey));});
 it.each(['quantity','availableQty','sampleId','receiptSnapshot','actorId'])('forbids %s extra field',field=>expect(()=>parseSampleCardMoveInput({...good(),[field]:1})).toThrow());
 it.each(['targetLocation','reason'])('requires explicit %s',field=>{const r:any=good();delete r[field];expect(()=>parseSampleCardMoveInput(r)).toThrow();});
 it.each(['01','-1','1.0','9223372036854775808',123,null])('invalid version token %s',expectedUpdatedAt=>expect(()=>parseSampleCardMoveInput({...good(),expectedUpdatedAt})).toThrow());
 it.each(['',' space ','a\n',1])('rejects malformed location %s',targetLocation=>expect(()=>parseSampleCardMoveInput({...good(),targetLocation})).toThrow());
 it('accepts explicit unknown shelf and reason; rejects invalid date',()=>{expect(parseSampleCardMoveInput({...good(),targetLocation:null,reason:null}).targetLocation).toBeNull();expect(()=>parseSampleCardMoveInput({...good(),occurredDate:'2026-02-30'})).toThrow();});
});
