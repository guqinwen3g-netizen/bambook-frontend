import { canonicalOrderSampleJson, orderSampleDate, orderSampleDigest } from './orderSampleSourceContract';
import { orderSampleCommandFailure, orderSampleCommandId, orderSampleCommandKey } from './orderSampleCommandContract';
export const SAMPLE_CARD_MOVE_PROTOCOL = 'sample_card_move_v1' as const;
export const SAMPLE_CARD_MOVE_OPERATION = 'move_sample_card' as const;
export type SampleCardMoveInput = {
  moveVersion: 1; requestKey: string; expectedUpdatedAt: string; expectedCustodyFingerprint: string;
  targetWarehouseId: string; targetLocation: string | null; occurredDate: string; reason: string | null;
};
const invalid = (message:string):never => orderSampleCommandFailure('INVALID_INPUT',message);
export function parseSampleCardMoveInput(raw:unknown):SampleCardMoveInput {
  canonicalOrderSampleJson(raw); const r=raw as any;
  const fields=['moveVersion','requestKey','expectedUpdatedAt','expectedCustodyFingerprint','targetWarehouseId','targetLocation','occurredDate','reason'];
  if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).length!==fields.length||fields.some(k=>!Object.hasOwnProperty.call(r,k)))invalid('请保留完整移位命令，不能提交数量、业务归属或收样字段。');
  if(r.moveVersion!==1||typeof r.expectedUpdatedAt!=='string'||! /^(0|[1-9]\d*)$/.test(r.expectedUpdatedAt)||BigInt(r.expectedUpdatedAt)>BigInt('9223372036854775807')||typeof r.expectedCustodyFingerprint!=='string'||! /^[a-f0-9]{64}$/.test(r.expectedCustodyFingerprint))invalid('请保留打开时的实物版本与归属指纹。');
  for(const key of ['targetLocation','reason'])if(r[key]!==null&&(typeof r[key]!=='string'||!r[key].trim()||r[key].trim()!==r[key]||r[key].length>500||/[\u0000-\u001f]/.test(r[key])))invalid('架位与移位说明须为明确文本或null。');
  return {moveVersion:1,requestKey:orderSampleCommandKey(r.requestKey),expectedUpdatedAt:r.expectedUpdatedAt,expectedCustodyFingerprint:r.expectedCustodyFingerprint,targetWarehouseId:orderSampleCommandId(r.targetWarehouseId),targetLocation:r.targetLocation,occurredDate:orderSampleDate(r.occurredDate),reason:r.reason};
}
export function sampleCardMoveCommand(actorId:string,cardId:string,input:SampleCardMoveInput) {
  return {moveVersion:1 as const,operation:SAMPLE_CARD_MOVE_OPERATION,actorId:orderSampleCommandId(actorId),cardId:orderSampleCommandId(cardId),requestKey:input.requestKey,input};
}
export const sampleCardMoveReceiptId=(actorId:string,key:string)=>'SCMOVE_'+orderSampleDigest({moveVersion:1,operation:SAMPLE_CARD_MOVE_OPERATION,actorId,requestKey:key});
export type SampleCardMoveAck={moveVersion:1;outcome:'moved';actorId:string;cardId:string;requestKey:string;commandHash:string;requestInput:SampleCardMoveInput;auditId:string;createdAt:string;before:{warehouseId:string|null;location:string|null;updatedAt:string};after:{warehouseId:string;location:string|null;updatedAt:string};preservedCardHash:string};
export type SampleCardMoveRecovery={moveVersion:1;outcome:'moved'|'cancelled'|'not_confirmed';actorId:string;cardId:string;requestKey:string;commandHash:string;requestInput:SampleCardMoveInput;auditId:string|null;ack?:SampleCardMoveAck};
