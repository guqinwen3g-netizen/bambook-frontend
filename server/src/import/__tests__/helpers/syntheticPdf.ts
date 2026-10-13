/**
 * 手造最小单页 PDF（测试专用）。
 *
 * 为什么需要它：Peerless 的解析器用例都读真实 PO PDF，而"缺行"这类**负向**场景
 * 没法从真 PO 里造出来。用最小 PDF + TL/T* 换行，pdf-parse 抽取后能保留行结构，
 * 于是负向用例可以走通 `parseOrderPdf` 全链（而不是只测 `parsePeerless`）。
 */
export function buildPdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  let content = 'BT\n/F1 10 Tf\n14 TL\n20 760 Td\n';
  lines.forEach((l, i) => {
    if (i > 0) content += 'T*\n';
    content += `(${esc(l)}) Tj\n`;
  });
  content += 'ET\n';

  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefPos = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** 一份"结构完整、可被 detectCustomer 判为 peerless"的合成 PO 文本行。 */
export function peerlessHeaderLines(): string[] {
  return [
    'Vetements Peerless Clothing Inc.',
    'T.V.Q./Q.S.T. No 1000873531',
    'PO number / season / date',
    '4500159423 / F26-INSTOCK / 2026/03/31',
    'Contact person/Telephone',
    'Sonya Catalano/514-593-9300 EXT:1510',
    'Currency USD',
  ];
}

export const TOTAL_NET_LINE = 'Tot. net item val. excl. tax USD 103.680,00';
export const ACTUAL_PRICE_LINE = 'Actual price 103.680,00';
