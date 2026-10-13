import {describe,it,expect} from 'vitest';
import {quantityCredentialCeiling} from '../quantityPlanCredential';
const actor=(extra:any)=>({userId:'private',roles:[],departmentIds:[],...extra}) as any;
describe('quantity signed credential limits',()=>{
 it('retains signed permissions without an explicit ceiling',()=>expect(quantityCredentialCeiling(actor({permissions:['orders:read']}))).toEqual(['orders:read']));
 it('retains existing explicit-cap precedence over signed permission snapshots',()=>expect(quantityCredentialCeiling(actor({permissions:['orders:read'],permissionCeiling:['orders:read','order:change_request:apply']}))).toEqual(['orders:read','order:change_request:apply']));
 it('retains a narrower explicit ceiling',()=>expect(quantityCredentialCeiling(actor({permissions:['orders:read','order:change_request:apply'],permissionCeiling:['orders:read']}))).toEqual(['orders:read']));
 it('retains authoritative empty signed permissions without a cap',()=>expect(quantityCredentialCeiling(actor({permissions:[]}))).toEqual([]));
 it('signed wildcard remains bounded by explicit scopes',()=>expect(quantityCredentialCeiling(actor({permissions:['*'],permissionCeiling:['orders:read']}))).toEqual(['orders:read']));
 it('legacy role-only omission does not manufacture a wildcard',()=>expect(quantityCredentialCeiling(actor({roles:['sales']}))).toBeUndefined());
 it('malformed credential scopes fail closed',()=>expect(()=>quantityCredentialCeiling(actor({permissions:[' orders:read ']}))).toThrow());
});
