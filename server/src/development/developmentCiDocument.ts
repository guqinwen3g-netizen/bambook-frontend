import { DOC_PRINT_BASE_STYLES, esc } from '../templates/docPrintBase';
import { localDateKey } from '../shared/localDate';


/** A development charge is an amount for services, never a fabricated shipment/order line. */
export function renderDevelopmentCiDocument(source: any, screen = false) {
  const { document, version, snapshot: s } = source;
  const bank = s.exporterSnapshot;
  const commercial = s.protocolVersion === 2;
  const rows = s.lines.map((line: any) => `<tr>${commercial ? `<td>${esc(line.roundLabel)}<br>${esc(line.sourceLabel)}</td><td>${esc(line.purpose)}</td>` : ''}<td>${esc(line.description)}</td><td class="amount">${esc(line.currency)} ${esc(line.amount)}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(document.documentNumber)}</title><style>${DOC_PRINT_BASE_STYLES}
  @page{size:A4;margin:15mm}body{font:12px Arial,sans-serif;color:#182024}.paper{max-width:180mm;margin:auto}h1{font-size:23px}table{width:100%;border-collapse:collapse}td,th{padding:9px;border-bottom:1px solid #ddd;text-align:left}.parties{display:flex;gap:30px;margin:24px 0}.parties>div{flex:1}.muted{color:#667085}.amount{text-align:right;white-space:nowrap}pre{font:inherit;white-space:pre-wrap}</style></head><body><main class="paper">
  <h1>COMMERCIAL INVOICE</h1><p>${esc(document.documentNumber)} · ${esc(s.issueDate)}${s.issuedAt ? '' : ' · DRAFT'}</p>
  <div class="parties"><div><strong>SELLER</strong><pre>${esc(bank.nameEn)}\n${esc(bank.addressEn ?? '')}</pre></div><div><strong>BILL TO</strong><pre>${esc(s.parties.billTo.name)}\n${esc(s.parties.billTo.address ?? '')}</pre></div></div>
  <p>Development reference: ${esc(s.caseCode)}${s.dueDate ? ` · Due: ${esc(s.dueDate)}` : ''}</p>
  ${commercial && s.fields.note ? `<p>${esc(s.fields.note)}</p>` : ''}
  ${s.paymentTerms ? `<p>Payment terms: ${esc(s.paymentTerms)}</p>` : ''}
  <table><thead><tr>${commercial ? '<th>Round / Reference</th><th>Purpose</th>' : ''}<th>Description</th><th class="amount">Amount</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><th${commercial ? ' colspan="3"' : ''}>Total</th><th class="amount">${esc(s.currency)} ${esc(s.totalAmount)}</th></tr></tfoot></table>
  <section style="margin-top:25px"><strong>Bank details</strong>${[['Beneficiary', bank.beneficiary], ['Bank', bank.bankName], ['SWIFT', bank.swiftCode], ['Bank address', bank.bankAddress], ['Account', bank.usdAccountNumber]].filter(([, value]) => value).map(([label, value]) => `<p>${esc(label)}: ${esc(value)}</p>`).join('')}</section>
  <p class="muted">Version ${esc(version.version)}${s.issuedAt ? ` · Issued ${esc(localDateKey(new Date(Number(s.issuedAt))))}` : ''}</p></main></body></html>`;
}
