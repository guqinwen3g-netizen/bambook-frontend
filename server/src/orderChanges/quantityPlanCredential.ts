import type {Request} from 'express';
import {createAuthService, type TokenPayload} from '../auth/service';
import {extractActorFromRequest, pickRequestToken} from '../auth/middleware';
import {businessError} from '../shared/errorCodes';

/** Preserve the existing explicit-cap precedence before refreshing current DB grants. */
export function quantityCredentialCeiling(actor:TokenPayload):string[]|undefined {
  const value=actor.permissionCeiling!==undefined?actor.permissionCeiling:actor.permissions;
  if(value===undefined)return undefined; // Existing role-only JWT compatibility, never grant '*'.
  if(!Array.isArray(value)||value.some(scope=>typeof scope!=='string'||!scope||scope.trim()!==scope))throw businessError('FORBIDDEN','原凭据权限上限不可用');
  return [...new Set(value)];
}

/** This JWT-only route must not substitute its hydrated actor for the signed credential. */
export function signedQuantityPlanActor(req:Request):TokenPayload {
  let signed:TokenPayload;
  try{signed=createAuthService().verifyToken(pickRequestToken(req));}catch{throw businessError('UNAUTHORIZED','数量变更需要有效登录凭据');}
  if(!signed?.userId||(signed as any).kind==='customer'||!Array.isArray(signed.roles)||signed.userId!==extractActorFromRequest(req)?.userId)throw businessError('UNAUTHORIZED','原凭据与当前主体不一致');
  const ceiling=quantityCredentialCeiling(signed);
  return {...signed,...(ceiling!==undefined?{permissionCeiling:ceiling}:{})};
}
