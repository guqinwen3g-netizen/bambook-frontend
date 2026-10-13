export interface ParsedLine {
  itemNo: string;
  materialCode: string;
  millQuality: string;
  description: string;
  width: string;
  exMillDate: string;
  deliveryDate: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  netValue: number;
  via: string;
  cloth: string;
  weight?: string;
  category?: string;
  notes?: string[];
}

export interface ParsedShipTo {
  contactName?: string;
  company?: string;
  addressLines: string[];
  country?: string;
}

export interface ParsedOrder {
  customerId: 'peerless';
  poNumber: string;
  season: string;
  poDate: string;
  contactPerson: string;
  contactPhone: string;
  currency: string;
  deliveryTerms: string;
  paymentTerms: string;
  shipTo: ParsedShipTo;
  deliverTo?: string;
  lines: ParsedLine[];
  totalNet: number;
  totalActual: number;
}

export interface DetectionResult {
  customerId: string | null;
  confidence: number;
  reasons: string[];
}

export interface ParseResult {
  detection: DetectionResult;
  order?: ParsedOrder;
  rawText: string;
  pages: number;
  error?: string;
}
