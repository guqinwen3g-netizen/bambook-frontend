import { DOC_PRINT_BASE_STYLES, esc } from '../templates/docPrintBase';
import type { readFabricCommissionOriginal } from './fabricCommissionSource';

/** Render only the issued original; no editable amount or goods receivable is
 * synthesized in the template. This is a commission service CI to a supplier. */
export function renderFabricCommissionDocument(original: Awaited<ReturnType<typeof readFabricCommissionOriginal>>) {
  const { document, snapshot, group } = original, exporter = snapshot.exporterSnapshot;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(document.documentNumber)}</title><style>${DOC_PRINT_BASE_STYLES}
  @page{size:A4;margin:15mm}body{font:12px Arial,sans-serif;color:#182024}.paper{max-width:180mm;margin:auto}h1{font-size:23px}table{width:100%;border-collapse:collapse}td,th{padding:9px;border-bottom:1px solid #ddd;text-align:left}.parties{display:flex;gap:30px;margin:24px 0}.parties>div{flex:1}pre{font:inherit;white-space:pre-wrap}.number{text-align:right}</style></head><body><main class="paper">
  <h1>COMMERCIAL INVOICE — FABRIC COMMISSION</h1><p>${esc(document.documentNumber)} · ${esc(snapshot.issueDate)}</p>
  <div class="parties"><div><strong>FROM</strong><pre>${esc(exporter.nameEn)}\n${esc(exporter.addressEn)}</pre></div><div><strong>BILL TO — SUPPLIER</strong><pre>${esc(group.party.name)}\n${esc(group.party.address ?? '')}</pre></div></div>
  <p>Order: ${esc(snapshot.source.orderNumber)}${snapshot.source.poNumber ? ` · PO: ${esc(snapshot.source.poNumber)}` : ''}${snapshot.dueDate ? ` · Due: ${esc(snapshot.dueDate)}` : ''}</p>
  <p>Commission for the actual completed shipments. The customer pays the supplier directly for the goods.</p>
  <table><thead><tr><th>Description</th><th class="number">Actual goods value</th><th class="number">Rate</th><th class="number">Commission</th></tr></thead><tbody>${group.lines.map(line => `<tr><td>${esc(line.description ?? line.orderLineId)}<br>${esc(line.actualQuantity)} ${esc(line.unit)}</td><td class="number">${esc(snapshot.source.currency)} ${esc(line.actualGoodsAmount)}</td><td class="number">${esc(line.rate)}%</td><td class="number">${esc(snapshot.source.currency)} ${esc(line.commissionAmount)}</td></tr>`).join('')}</tbody><tfoot><tr><th colspan="3">Commission total</th><th class="number">${esc(snapshot.source.currency)} ${esc(group.commissionAmount)}</th></tr></tfoot></table>
  <section style="margin-top:25px"><strong>Bank details</strong>${[['Beneficiary', exporter.beneficiary], ['Bank', exporter.bankName], ['SWIFT', exporter.swiftCode], ['Account', exporter.usdAccountNumber]].filter(([, value]) => value).map(([label, value]) => `<p>${esc(label)}: ${esc(value)}</p>`).join('')}</section>
  <p>Original version ${esc(original.version.version)} · Settlement ${esc(snapshot.settlementId)}</p></main></body></html>`;
}
