import {apiService} from './apiService';
import {getAuthState,hasPermission} from './authService';
import {runFinanceCommand} from './financeCommandRecovery';
export interface CompanyCashAccount {id:string;name:string;companyName:string;currency:string;bankName:string;accountName:string;accountNumberMasked:string;branch:string|null;
  status:'Active'|'Archived';ownerId:string|null;teamId:string|null;departmentId:string|null;allowedUserIds:string[];revision:number;companyRelationId:string|null;createdAt:string;updatedAt:string}
export interface CashAccountEntry {id:string;accountId:string;sequence:number;kind:'Opening'|'Receipt'|'Payment'|'CorrectionIn'|'CorrectionOut';amount:string;signedAmount:string;
  currency:string;occurredDate:string;sourceVoucherId:string|null;correctsEntryId:string|null;evidence:any;reason:string|null;postedBy:string;postedAt:string}
export interface CashAccountView {account:CompanyCashAccount;balance:string|null;recordedBalance:string|null;recordedNetMovement:string|null;balanceStatus:'unknown'|'verified';balanceReason:string|null;
  negative:boolean|null;sourcesAvailable:boolean;opening:CashAccountEntry|null;entries:CashAccountEntry[]|null}
export type CashAccountCreateInput=Pick<CompanyCashAccount,'name'|'companyName'|'currency'|'bankName'|'accountName'|'accountNumberMasked'|'allowedUserIds'> &
  Partial<Pick<CompanyCashAccount,'branch'|'ownerId'|'teamId'|'departmentId'|'companyRelationId'>> & {requestKey?:string};
export type CashAccountCommandInput={action:'update'|'opening'|'correction';requestKey?:string;expectedRevision?:number;changes?:Record<string,unknown>;
  amount?:string;currency?:string;occurredDate?:string;bankReference?:string;evidenceNote?:string;reason?:string;correctsEntryId?:string};
const path='/v1/finance/cash-accounts';
async function read(relative:string,endpoint?:string){const auth=getAuthState(),base=endpoint??apiService.getStoredConfig().cloudEndpoint,headers=apiService.getAuthHeaders();
  if(!auth.isAuthenticated||!hasPermission('vouchers:read'))throw Error('当前账号无公司资金读取权限。');
  const identity=JSON.stringify([auth.user?.id,headers,base,auth.user?.permissions,auth.user?.permissionCeiling]);
  const current=()=>{const now=getAuthState();if(!hasPermission('vouchers:read')||identity!==JSON.stringify([now.user?.id,apiService.getAuthHeaders(),endpoint??apiService.getStoredConfig().cloudEndpoint,now.user?.permissions,now.user?.permissionCeiling]))throw Error('当前账号、权限或服务地址已变化，请重新读取账户。');};
  const response=await fetch(apiService.buildApiUrl(path+relative,base),{headers});current();const body=await response.json();current();
  if(!response.ok||!body?.ok)throw Error(body?.error?.message||'公司资金暂不可核实。');return body;}
export const cashAccountReference=(id:string)=>({path:`${path}/${encodeURIComponent(id)}`,entity:'account',id,versionField:'revision',inputField:'expectedAccountRevision'});
export const companyCashAccountService={
  async list(endpoint?:string):Promise<CashAccountView[]>{const body=await read('',endpoint);if(!Array.isArray(body.items))throw Error('公司账户列表回执不完整。');return body.items;},
  async get(id:string,endpoint?:string):Promise<CashAccountView>{const body=await read(`/${encodeURIComponent(id)}`,endpoint);if(body.account?.id!==id||!Number.isSafeInteger(body.account?.revision)||!['unknown','verified'].includes(body.balanceStatus))throw Error('公司资金回执不完整。');return body;},
  async create(input:CashAccountCreateInput,endpoint?:string):Promise<CompanyCashAccount>{return runFinanceCommand({kind:'cash_account.create',path,method:'POST',permission:'vouchers:write',entity:'account',input:{...input}},endpoint);},
  async command(id:string,input:CashAccountCommandInput,endpoint?:string):Promise<CompanyCashAccount>{return runFinanceCommand({kind:`cash_account.${input.action}`,targetId:id,path:`${path}/${encodeURIComponent(id)}/commands`,method:'POST',permission:'vouchers:write',entity:'account',input:{...input},hashExtra:{accountId:id},
    references:[{...cashAccountReference(id),inputField:'expectedRevision'}]},endpoint);},
};
