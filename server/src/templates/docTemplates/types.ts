/**
 * 服务端单据模板共用类型（docTemplates/ 体系）。
 *
 * ServerDocumentSetData = shipping/documentSetService.assembleDocumentSetData
 * 装配输出的形状（与前端 types.ts DocumentSetData 同构的服务端副本——服务端
 * 不能 import 前端类型，此处保持结构同步；字段回退链真源在 documentSetService）。
 */

export interface ServerDocumentSetParty {
  name: string;
  address?: string | null;
  contact?: string | null;
}
/** Native supplier templates preserve Decimal strings and immutable revision
 * identity. They do not share the mutable legacy PO numeric DTO. */
export interface ServerSupplierContractDocumentData {
  supplierContractDocumentProtocol: 1;
  document: Awaited<ReturnType<typeof import('../../procurement/supplierContractDocument').readSupplierContractDocument>>;
}

export interface ServerDocumentSetLine {
  lineNumber: number;
  description: string;
  productCode?: string | null;
  hsCode?: string | null;
  quantity: number | null;
  unit?: string | null;
  unitPrice?: number | null;
  amount?: number | null;
  cartons?: number | null;
  grossWeight?: number | null;
  netWeight?: number | null;
  volume?: number | null;
  originCountry?: string | null;
}

export interface ServerDocumentSetData {
  shipment: {
    id: string;
    shipmentNumber: string;
    status: string;
    type?: string;
    shippingMethod?: string | null;
    vesselOrFlight: string | null;
    voyageNumber: string | null;
    portOfLoading: string | null;
    portOfDischarge: string | null;
    containerNumber: string | null;
    sealNumber: string | null;
    bookingDate?: string | null;
    etd?: string | null;
    atd?: string | null;
    eta?: string | null;
    totalPackages: number | null;
    grossWeight: number | null;
    netWeight: number | null;
    volume: number | null;
    hsCode?: string | null;
    customsDeclarationNumber?: string | null;
    notes?: string | null;
  };
  order: {
    id: string;
    poNumber: string | null;
    customer: string;
    currency?: string | null;
    deliveryTerms?: string | null;
    paymentTerms?: string | null;
    salesContractNumber?: string | null;
    finalContractNumber?: string | null;
    invoiceNumber?: string | null;
    invoiceDate?: string | null;
  } | null;
  customs: {
    declarationNumber: string;
    declarationDate?: string | null;
    declarationPort?: string | null;
    tradeTerms?: string | null;
    totalValue?: number | null;
    currency?: string | null;
    originCountry?: string | null;
    destinationCountry?: string | null;
    consignee?: string | null;
    consignor?: string | null;
  } | null;
  parties: {
    customer: ServerDocumentSetParty | null;
    consignee: ServerDocumentSetParty | null;
    carrier: { name: string } | null;
  };
  lines: ServerDocumentSetLine[];
  totals: {
    quantity: number | null;
    amount: number | null;
    cartons: number | null;
    grossWeight: number | null;
    netWeight: number | null;
    volume: number | null;
    currency: string | null;
  };
  missing?: string[];
  extras?: Record<string, any>;
}
