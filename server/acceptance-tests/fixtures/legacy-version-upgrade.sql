-- Synthetic upgrade input only: old drafts and queued review, no received
-- sample, quality pass, requester confirmation, stock or loading conclusion.
INSERT INTO "Role" ("id","name","isSystem","updatedAt") VALUES
('role-qc','Synthetic professional QC',TRUE,NOW()),
('role-super-admin','Synthetic super administrator',TRUE,NOW()),
('role-sales','Synthetic business owner',TRUE,NOW()),
('role-admin','Synthetic ordinary administrator',TRUE,NOW());
INSERT INTO "Permission" ("id","scope") VALUES ('UPGRADE_QC_MANAGE','qc:write');
INSERT INTO "RolePermission" ("id","roleId","permissionId") VALUES
('UPGRADE_QC_OLD_GRANT','role-qc','UPGRADE_QC_MANAGE'),
('UPGRADE_BUSINESS_OLD_GRANT','role-sales','UPGRADE_QC_MANAGE');
INSERT INTO "UserAccount" ("id","displayName","email","status","updatedAt")
VALUES ('UPGRADE_DRAFT_ACTOR','Synthetic legacy draft owner','upgrade-draft@acceptance.bambook.local','active',NOW());
INSERT INTO "DevelopmentCase" ("id","code","name","type","stage","ownerId","createdAt","updatedAt")
VALUES ('UPGRADE_DRAFT_CASE','UPGRADE-DRAFT-CASE','Synthetic legacy draft','fabric','developing','UPGRADE_DRAFT_ACTOR',1,1);
INSERT INTO "SampleBatch" ("id","batchCode","developmentCaseId","supplierRelationId","sampleType","status","createdAt","updatedAt")
VALUES ('UPGRADE_DRAFT_BATCH','UPGRADE-DRAFT-BATCH','UPGRADE_DRAFT_CASE','UPGRADE_UNKNOWN_FACTORY','lab-dip','pending',1,1);
INSERT INTO "DevelopmentSampleQualityReview" ("id","sampleBatchId","developmentCaseId","requestKey","sourceFingerprint","sourceSnapshot","status","requestedBy","requestedAt","createdAt","updatedAt")
VALUES ('UPGRADE_QUEUED_REVIEW','UPGRADE_DRAFT_BATCH','UPGRADE_DRAFT_CASE','UPGRADE-QUEUED-REQUEST',REPEAT('0',64),'{"legacy":"queued unknown exact version"}'::jsonb,'queued','UPGRADE_DRAFT_ACTOR',1,1,1);
INSERT INTO "Order" ("id","poNumber","customer","product","type","quantity","unit","status","dueDate","quoteAmount","ownerId","updatedAt")
VALUES ('UPGRADE_DRAFT_ORDER','UPGRADE-CUSTOMER-PO','Synthetic legacy customer','Synthetic unapproved garment draft','Garment',100,'PC','Pending','2099-01-01',2500,'UPGRADE_DRAFT_ACTOR',1);
INSERT INTO "OrderLine" ("id","orderId","lineNumber","itemNo","quantity","unit")
VALUES ('UPGRADE_DRAFT_LINE','UPGRADE_DRAFT_ORDER',1,'0010',100,'PC');
INSERT INTO "PurchaseOrder" ("id","poNumber","status","currency","totalAmount","orderDate","orderId","buyer","createdAt","updatedAt")
VALUES ('UPGRADE_DRAFT_PURCHASE','UPGRADE-DRAFT-PURCHASE','Draft','USD',12.3456,'2026-10-01','UPGRADE_DRAFT_ORDER','Legacy free-text buyer',1,1);
INSERT INTO "PurchaseLine" ("id","purchaseOrderId","lineNumber","description","quantity","unit","unitPrice","amount","createdAt")
VALUES ('UPGRADE_DRAFT_PURCHASE_LINE','UPGRADE_DRAFT_PURCHASE',1,'Synthetic unknown-source legacy draft material',12,'M',1.0288,12.3456,1);
INSERT INTO "OutsourcingOrder" ("id","orderNumber","orderId","processType","quantity","unit","unitPrice","currency","totalAmount","status","createdAt","updatedAt")
VALUES ('UPGRADE_DRAFT_PROCESSING','UPGRADE-DRAFT-PROCESSING','UPGRADE_DRAFT_ORDER','Sewing',100,'PC',2.5,'USD',250,'Draft',1,1);
INSERT INTO "OutsourcingLine" ("id","outsourcingOrderId","processType","description","quantity","unit","unitPrice","amount","createdAt","updatedAt")
VALUES ('UPGRADE_DRAFT_PROCESSING_LINE','UPGRADE_DRAFT_PROCESSING','Sewing','Synthetic unknown-source legacy draft process',100,'PC',2.5,250,1,1);
