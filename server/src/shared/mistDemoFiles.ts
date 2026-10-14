/**
 * 演示工作区的示例附件。附件内容由当前工作区数据实时生成为真实可下载的 PDF（英文，单页），
 * 文件名与正文都标明“演示数据”。只有 storageKey 以 DEMO_FILE_PREFIX 开头的记录会被服务端写入存储。
 */
import type { MistFile, MistState } from './mistWorkspace';

export const DEMO_FILE_PREFIX = 'demo-seed/';
export type DemoFileTemplate = 'customer-po' | 'commercial-invoice' | 'packing-list' | 'customs-release' | 'supplier-contract';

export function demoFileRecord(id: string, template: DemoFileTemplate, ref: string, name: string, createdAt: string): MistFile {
  return { id, name, mimeType: 'application/pdf', size: 0, storageKey: `${DEMO_FILE_PREFIX}${template}/${encodeURIComponent(ref)}`, createdAt };
}

export function isDemoFile(file: MistFile) { return file.storageKey.startsWith(DEMO_FILE_PREFIX); }

/** 按模板从工作区数据生成 PDF 字节。找不到引用对象时仍生成说明页，不抛错。 */
export function renderDemoFile(state: MistState, file: MistFile): Uint8Array {
  const [template, rawRef] = file.storageKey.slice(DEMO_FILE_PREFIX.length).split('/') as [DemoFileTemplate, string];
  const ref = decodeURIComponent(rawRef || '');
  const order = state.orders.find(o => o.id === ref || o.code === ref);
  const customer = order ? state.customers.find(c => c.id === order.customerId) : undefined;
  const lines = order ? state.orderLines.filter(l => l.orderId === order.id) : [];
  const purchase = state.fulfillment?.purchases.find(p => p.id === ref);
  const shipment = state.fulfillment?.shipments.find(s => s.id === ref);
  const body: string[] = [];
  const title = { 'customer-po': 'PURCHASE ORDER', 'commercial-invoice': 'COMMERCIAL INVOICE', 'packing-list': 'PACKING LIST', 'customs-release': 'CUSTOMS RELEASE NOTICE', 'supplier-contract': 'SUPPLY CONTRACT' }[template] || 'DOCUMENT';
  if (template === 'customer-po' && order) {
    body.push(`Buyer: ${ascii(customer?.name || order.customer)}`, `Seller: Bambook Apparel Co., Ltd.`, `Order: ${order.code}    Season: ${ascii(order.season)}    Currency: ${order.currency}`, `Delivery: ${order.due}    Terms: ${ascii(customer?.incoterm || 'FOB Shanghai')}    Payment: ${ascii(customer?.terms || 'T/T')}`, '');
    body.push('Style                         Qty        Unit price');
    for (const l of lines) body.push(`${pad(ascii(l.style), 30)}${pad(String(l.qty) + ' ' + unit(l.unit), 11)}${order.currency} ${l.price.toFixed(2)}`);
    body.push('', `Total quantity: ${lines.reduce((s, l) => s + l.qty, 0)}`, '', 'Confirmed by buyer (signature on file).');
  } else if ((template === 'commercial-invoice' || template === 'packing-list' || template === 'customs-release') && shipment) {
    const shipped = shipment.lines.map(l => ({ line: state.orderLines.find(x => x.id === l.lineId), qty: l.quantity }));
    const shipOrder = state.orders.find(o => o.id === shipment.lines[0]?.orderId);
    body.push(`Shipment: ${shipment.code}    Mode: ${shipment.mode.toUpperCase()}    Booking: ${ascii(shipment.booking) || '-'}`, `From: ${ascii(shipment.portOfLoading)}    To: ${ascii(shipment.portOfDischarge)}    Incoterm: ${ascii(shipment.incoterm)}`, `Consignee: ${ascii(shipment.consignee)}`, '');
    if (template === 'packing-list') { const packs = state.fulfillment.packing.filter(p => p.shipmentId === shipment.id); body.push('Cartons          Qty     N.W. kg   G.W. kg   CBM'); for (const p of packs) body.push(`${pad(ascii(p.carton), 17)}${pad(String(p.quantity), 8)}${pad(String(p.netWeight), 10)}${pad(String(p.grossWeight), 10)}${p.volume}`); }
    else if (template === 'commercial-invoice') { body.push('Style                         Qty        Amount'); for (const s of shipped) body.push(`${pad(ascii(s.line?.style || ''), 30)}${pad(String(s.qty), 11)}${shipOrder?.currency || ''} ${((s.line?.price || 0) * s.qty).toFixed(2)}`); }
    else { const c = state.fulfillment.customs.find(x => x.shipmentId === shipment.id); body.push(`Declaration: ${ascii(c?.declarationNo || '')}`, `HS code: ${ascii(c?.hsCode || '')}    Declared: ${c?.declaredAt || ''}    Released: ${c?.clearedAt || ''}`, `Broker: Shanghai customs broker (on file)`); }
  } else if (template === 'supplier-contract' && purchase) {
    body.push(`Contract: ${purchase.code}    Order: ${state.orders.find(o => o.id === purchase.orderId)?.code || ''}`, `Quantity: ${purchase.quantity} ${unit(purchase.unit)}    Unit price: ${purchase.currency} ${purchase.price}`, `Due: ${purchase.due}`);
  } else body.push('The referenced record is no longer in this workspace.');
  body.push('', '', 'Sample document generated for the Bambook demo workspace. Not a real commercial document.');
  return pdf(title, body);
}

function ascii(value: string) { return value.replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim(); }
function unit(value: string) { return ({ '件': 'pcs', '米': 'm', '码': 'yd', '粒': 'pcs', '套': 'sets', '公斤': 'kg' } as Record<string, string>)[value] || ascii(value) || 'units'; }
function pad(value: string, width: number) { return value.length >= width ? value.slice(0, width - 1) + ' ' : value + ' '.repeat(width - value.length); }

/** 最小 PDF 1.4：单页 A4，Helvetica / Courier，纯 ASCII。 */
function pdf(title: string, lines: string[]): Uint8Array {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = ['BT', '/F1 20 Tf', '56 780 Td', `(${esc(title)}) Tj`, 'ET', 'BT', '/F2 10 Tf', '14 TL', '56 740 Td', ...lines.map(l => `(${esc(l)}) '`), 'ET'].join('\n');
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let out = '%PDF-1.4\n'; const offsets: number[] = [];
  objects.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}