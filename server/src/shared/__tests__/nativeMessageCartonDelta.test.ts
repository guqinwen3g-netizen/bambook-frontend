import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { readNativeProof, nativeSourceReview, sourceHash, assertNativeProof, functionSource, classSource, variableSource } from './utils/nativeMessageProof';
const root=path.resolve(__dirname,'../../../..');
const source=(f:string)=>fs.readFileSync(path.join(root,f),'utf8');
const review=JSON.parse(source(nativeSourceReview.currentSourceReviewReceiptPath));
function runtime(text:string):any {
 const module={exports:{}};
 const js=ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(js,{exports:module.exports,module},{timeout:1000});return module.exports;
}
describe('378a changed atom and exact source delta',()=>{
 it('reviews exactly eleven original atoms: ten unchanged plus businessError; original closed graph remains exact',()=>{
  expect(nativeSourceReview.reviewedExecutableProofAtoms).toBe(11);
  expect(review.atomReview).toHaveLength(11);
  expect(review.atomReview.filter((a:any)=>a.unchanged)).toHaveLength(10);
  expect(review.atomReview.filter((a:any)=>!a.unchanged).map((a:any)=>a.name)).toEqual(['businessError']);
  for(const a of review.atomReview){const extract={function:functionSource,class:classSource,variable:variableSource}[a.kind as 'function'];expect(extract(source(a.file),a.name)).toBe(a.current);expect(a.current===a.before).toBe(a.unchanged);}
  expect(readNativeProof(root).receipt.provenSites).toEqual(review.provenSites);
 });
 it('both full registry modules preserve all registered public code/status/literal semantics, unknown code rejection and legacy classification',()=>{
  expect(sourceHash(review.previousErrorCodesSource)).toBe('8324175e46607419d58e3399741737d6bdeab404f801e7ddb77500a26a73ed77');
  const before=runtime(review.previousErrorCodesSource),after=runtime(source('server/src/shared/errorCodes.ts'));
  expect(after.ERROR_CODES).toEqual(before.ERROR_CODES);
  for(const code of Object.keys(before.ERROR_CODES)){
   const a=before.businessError(code,'fixed public literal'),b=after.businessError(code,'fixed public literal');
   expect({code:b.code,statusCode:b.statusCode,message:b.message}).toEqual({code:a.code,statusCode:a.statusCode,message:a.message});
   expect(after.lookupErrorCode(code)).toEqual(before.lookupErrorCode(code));
  }
  expect(()=>before.businessError('__UNKNOWN__','SQL')).toThrow();expect(()=>after.businessError('__UNKNOWN__','SQL')).toThrow();
  for(const x of [null,undefined,{},new Error('SQL'),{code:'SOURCE_CHANGED',statusCode:409},{code:2,statusCode:'409'}])expect(after.isBusinessError(x)).toBe(before.isBusinessError(x));
 });
 it('new private mint cannot be forged or rewritten by mutation of public Error fields',()=>{
  const after=runtime(source('server/src/shared/errorCodes.ts')),e=after.businessError('SOURCE_CHANGED','fixed');
  const mint=after.readBusinessErrorMint(e);expect(mint).toEqual({code:'SOURCE_CHANGED',statusCode:409,message:'fixed'});expect(Object.isFrozen(mint)).toBe(true);
  for(const fake of [null,{},Object.assign(new Error('fixed'),{code:'SOURCE_CHANGED',statusCode:409}),{...e}])expect(after.readBusinessErrorMint(fake)).toBeNull();
  e.code='FORBIDDEN';e.statusCode=403;e.message='SQL';expect(after.readBusinessErrorMint(e)).toEqual(mint);expect(mint.message).toBe('fixed');
 });
 it('exactly two main pins and three dependency pins changed; every predecessor main pin still rejects',()=>{
  const proof=readNativeProof(root);
  expect(review.sourceDeltas.map((x:any)=>x.file).sort()).toEqual(['server/src/shared/errorCodes.ts','server/src/shipping/route.ts']);
  expect(review.dependencyDeltas.map((x:any)=>x.file).sort()).toEqual(['server/src/orders/orderLineWriteAccess.ts','server/src/shared/errorCodes.ts','server/src/shipping/route.ts']);
  for(const d of review.dependencyDeltas)expect(sourceHash(source(d.file))).toBe(d.current);
  for(const d of review.sourceDeltas)expect(()=>assertNativeProof(proof.sources,{...proof.receipt,sourceHashes:{...proof.receipt.sourceHashes,[d.file]:d.old}})).toThrow(`${d.file} changed since`);
 });
});
