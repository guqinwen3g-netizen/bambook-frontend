import { getAuthState } from './authService';
import { apiService } from './apiService';
import { dashboardReadIdentity } from './dashboardTaskService';
import { sampleRoomService } from './sampleRoomService';

export type SampleCustodyPending = {
  version: 1; actorId: string; endpoint: string; itemId: string;
  action: 'borrow' | 'viewing' | 'ship' | 'return'; target: string;
  input: Record<string, any>; uncertain: boolean;
};
function owner() {
  const actorId=getAuthState().user?.id;
  if(!actorId)throw new Error('请使用当前登录账号核对实物登记。');
  return {actorId,endpoint:apiService.getStoredConfig().cloudEndpoint || ''};
}
function prefix() { const value=owner();return `sample-custody-pending:v1:${encodeURIComponent(value.actorId)}:${encodeURIComponent(value.endpoint)}:`; }
function key(itemId:string) { return prefix()+encodeURIComponent(itemId); }
function matches(p:SampleCustodyPending) { const current=owner();return current.actorId===p.actorId&&current.endpoint===p.endpoint; }
function exact(p:SampleCustodyPending) {
  if(!matches(p))return false;
  const stored=localStorage.getItem(key(p.itemId));
  return stored!==null&&JSON.stringify(JSON.parse(stored))===JSON.stringify(p);
}
export const sampleCustodyCommandService = {
  read(itemId:string):SampleCustodyPending|null {
    let raw=localStorage.getItem(key(itemId));
    // Recover the active legacy namespace once; new keys never contain a token.
    if(!raw){const legacyKey=`sample-meter-pending:${dashboardReadIdentity()}:${itemId}`,legacyRaw=localStorage.getItem(legacyKey);
      if(legacyRaw){const legacy=JSON.parse(legacyRaw);if(legacy?.input?.requestKey&&legacy?.target&&['borrow','ship','return'].includes(legacy.action)){
        raw=JSON.stringify({version:1,...owner(),itemId,...legacy,uncertain:true});localStorage.setItem(key(itemId),raw);localStorage.removeItem(legacyKey);
      }}
    }
    if(!raw)return null;
    const value=JSON.parse(raw) as SampleCustodyPending;
    if(value?.version!==1||!matches(value)||value.itemId!==itemId||!['borrow','viewing','ship','return'].includes(value.action)
      ||typeof value.target!=='string'||!value.target||typeof value.input?.requestKey!=='string'||!value.input.requestKey)
      throw new Error('原实物登记未能核对，请保留记录并重新读取。');
    if(!value.uncertain){value.uncertain=true;localStorage.setItem(key(itemId),JSON.stringify(value));}
    return value;
  },
  list():SampleCustodyPending[] {
    const start=prefix(),result:SampleCustodyPending[]=[];
    for(let i=0;i<localStorage.length;i++){const candidate=localStorage.key(i);if(candidate?.startsWith(start)){
      const itemId=decodeURIComponent(candidate.slice(start.length)),value=this.read(itemId);if(value)result.push(value);
    }}
    return result;
  },
  begin(itemId:string,action:SampleCustodyPending['action'],target:string,input:Record<string,any>):SampleCustodyPending {
    const existing=this.read(itemId);if(existing)return existing;
    const original:SampleCustodyPending={version:1,...owner(),itemId,action,target,input:{...input,requestKey:crypto.randomUUID()},uncertain:false};
    // Persistence must succeed before any network write begins.
    localStorage.setItem(key(itemId),JSON.stringify(original));return original;
  },
  markUncertain(p:SampleCustodyPending):SampleCustodyPending {
    if(!exact(p))return p;
    const next={...p,uncertain:true};localStorage.setItem(key(p.itemId),JSON.stringify(next));return next;
  },
  clear(p:SampleCustodyPending) { if(exact(p))localStorage.removeItem(key(p.itemId)); },
  async execute(p:SampleCustodyPending) {
    if(!exact(p))throw new Error('账号、服务或原登记已变化，请重新核对。');
    const identity=dashboardReadIdentity();
    try {
      const result=p.action==='return'?await sampleRoomService.returnLoan(p.target,p.input as any,p.endpoint):p.action==='ship'
        ?await sampleRoomService.shipItem(p.target,p.input as any,p.endpoint):await sampleRoomService.createLoan(p.target,p.input as any,p.endpoint);
      if(identity!==dashboardReadIdentity()||!matches(p))throw new Error('当前会话已变化，原实物登记仍需核对。');
      this.clear(p);return result;
    } catch(error:any) {
      // A later forbidden/conflict response cannot prove that the first request
      // did not commit. Rehydrated requests are treated as uncertain as well.
      if(!p.uncertain&&Number(error?.status)>=400&&Number(error?.status)<500)this.clear(p);
      else this.markUncertain(p);
      throw error;
    }
  },
};
