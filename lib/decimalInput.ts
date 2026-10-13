/** Decimal(18,4) business inputs stay text all the way to the server.
 * Old numeric readbacks are compatible, but lost historical digits cannot be recovered. */
export function canonicalDecimal18_4(value: unknown, label = '金额', allowNegative = false): string {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`${label}须填写精确数字，最多四位小数。`);
  const text = String(value).trim();
  if (!/^-?\d+(?:\.\d{1,4})?$/.test(text)) throw new Error(`${label}须填写精确数字，最多四位小数。`);
  const negative = text.startsWith('-');
  const [integer, decimal = ''] = (negative ? text.slice(1) : text).split('.');
  const whole = integer.replace(/^0+(?=\d)/, '');
  const fraction = decimal.replace(/0+$/, '');
  if (whole.length > 14) throw new Error(`${label}整数部分最多十四位。`);
  const magnitude = whole + (fraction ? `.${fraction}` : '');
  if (negative && magnitude !== '0' && !allowNegative) throw new Error(`${label}不能为负数。`);
  return (negative && magnitude !== '0' ? '-' : '') + magnitude;
}
