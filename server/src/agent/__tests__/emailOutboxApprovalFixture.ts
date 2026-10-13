import { createHash } from 'node:crypto';
// The unit fixtures describe the same native server snapshot shape as the real
// helper. Actual route controls separately use the helper and producer directly.
const content = { id:'EML__1', fromAddress:'a@b.com', fromName:null,
  toAddresses:'["recipient@bambook.local"]',ccAddresses:'[]',bccAddresses:'[]',
  replyToAddress:null,subject:'Approved subject',bodyText:'Approved body',bodyHtml:null,
  hasAttachments:false,attachmentCount:0 };
export const approvalContext = { sendContextVersion:1 as const,emailId:'EML__1',content,
  contentHash:createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.keys(content).sort()
    .map(key=>[key,(content as any)[key]])))).digest('hex') };
export const emailActor:any = {userId:'u1',roles:['admin'],departmentIds:[],
  permissionScopes:['emails:write'],permissionsAuthoritative:true,toolScopes:['automation'],knowledgeScopes:['company'],memoryScopes:[]};
