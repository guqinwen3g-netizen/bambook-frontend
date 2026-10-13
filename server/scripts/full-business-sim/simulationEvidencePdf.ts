/** Explicitly fictional external evidence for the user-authorized dev script.
 * A valid, inspectable one-page PDF; it never claims to be a customs filing. */
export function simulationEvidencePdf(reference: string, shipmentId: string): Buffer {
  const escape = (value: string) => value.replace(/[^\x20-\x7e]/g, '?').replace(/[\\()]/g, '\\$&');
  const stream = ['BT /F1 14 Tf 48 780 Td', '(SIMULATION ONLY - FICTIONAL EXTERNAL EVIDENCE) Tj',
    '0 -28 Td', `(${escape(reference)}) Tj`, '0 -24 Td', `(${escape(shipmentId)}) Tj`,
    '0 -24 Td', '(Business as-of: 2026-10-08 08:18 Asia/Shanghai) Tj', 'ET'].join('\n');
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let text = '%PDF-1.4\n', offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(text)); text += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(text);
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}
