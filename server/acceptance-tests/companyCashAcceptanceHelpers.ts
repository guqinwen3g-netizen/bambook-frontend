/** Master identity is configured by its real HTTP producer; bank facts are
 * never seeded. Callers choose explicitly whether to register an Opening. */
import {randomUUID} from 'node:crypto';
import type {GlobalBusinessHttpFixture} from './globalBusinessFixtures';
function body(response:any,label:string){if(![200,201].includes(response.status))throw Error(`${label}: ${response.status} ${JSON.stringify(response.body)}`);return response.body;}
export async function createAcceptanceCashAccount(f:GlobalBusinessHttpFixture,options:{currency?:string;label?:string}={}){
  const input={requestKey:randomUUID(),name:`${f.prefix}-${options.label||'actual-bank'}`,companyName:'Synthetic seller',currency:options.currency||'USD',
    bankName:'Synthetic bank',accountName:'Synthetic seller',accountNumberMasked:'ACCEPTANCE-ONLY-****',
    ownerId:f.actors.finance.id,allowedUserIds:[f.actors.finance.id,f.actors.superAdmin.id]};
  return body(await f.request('superAdmin','post','/api/v1/finance/cash-accounts',input),'configure actual company account').account;
}
export async function acceptanceCashInput(f:GlobalBusinessHttpFixture,accountId:string){
  const current=body(await f.request('finance','get',`/api/v1/finance/cash-accounts/${encodeURIComponent(accountId)}`),'read exact account revision');
  return {companyAccountId:accountId,expectedAccountRevision:current.account.revision,bankReference:`${f.prefix}-BANK-${randomUUID()}`};
}
