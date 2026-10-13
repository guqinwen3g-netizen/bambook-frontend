import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
dotenv.config({path:'.env.local',override:true});
const db=new PrismaClient();
(BigInt.prototype as any).toJSON=function(){return this.toString()};
async function main(){
 const url=new URL(process.env.DATABASE_URL!); console.log('TARGET',url.hostname,url.pathname);
 const orders=await db.order.findMany({where:{deletedAt:null},include:{lines:true}});
 console.log('ORDER_COUNTS',orders.reduce((a:any,o)=>{a[o.type]=(a[o.type]||0)+1;return a},{}));
 console.log('ORDERS',JSON.stringify(orders.map(o=>({id:o.id,source:o.source,code:o.code,type:o.type,businessLine:o.businessLine,product:o.product,customer:o.customer,owner:o.ownerId,lines:o.lines.map(l=>({id:l.id,material:l.materialCode,description:l.description,source:l.confirmedSourceType,snapshot:l.specSnapshot,qty:l.quantity,price:l.unitPrice,net:l.netValue}))})),null,2));
 console.log('COUNTS',JSON.stringify({assets:await db.productAsset.groupBy({by:['mainCategory'],where:{deletedAt:null},_count:true}),development:await db.developmentCase.groupBy({by:['type'],where:{deletedAt:null},_count:true}),relations:await db.relation.groupBy({by:['type'],where:{deletedAt:null},_count:true})}));
 console.log('ASSETS',JSON.stringify(await db.productAsset.findMany({where:{deletedAt:null},include:{fabricProfile:true,garmentProfile:true}})));
 console.log('DEVELOPMENT',JSON.stringify(await db.developmentCase.findMany({where:{deletedAt:null}})));
 console.log('TABLES',JSON.stringify(await db.$queryRaw`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('description','productName','productCode','name','title') ORDER BY table_name`));
 const inventory:any[]=[]; for(const model of ['sample','sampleBatch','sealSample','shipment','shipmentLine','invoice','invoiceLine','purchaseOrder','purchaseLine','outsourcingOrder','outsourcingLine','inventoryItem','quotation','quotationLine','supplierInquiry','fabricSearchTask','bom','notification']) { const delegate=(db as any)[model];if(delegate?.findMany){const rows=await delegate.findMany({take:500});inventory.push({model,count:await delegate.count(),examples:rows.slice(0,3),missingDescriptions:rows.filter((r:any)=>'description' in r&&!r.description).length});} } console.log('INVENTORY',JSON.stringify(inventory));
 console.log('DEPARTMENTS',JSON.stringify(await db.department.findMany({select:{id:true,name:true,status:true,metadata:true}})));
}
main().finally(()=>db.$disconnect());
