/** Supplier organization is identity; FactoryProfile is optional business detail. */
export const factoryRelationIdentitySelect={id:true,name:true,category:true,isOrganization:true,deletedAt:true} as const;
export function isUsableFactoryRelation(relation:unknown):relation is {id:string;name:string;category:'Supplier';isOrganization:true;deletedAt:null}{
 const row=relation as any;return !!row&&row.category==='Supplier'&&row.isOrganization===true&&row.deletedAt===null;
}
