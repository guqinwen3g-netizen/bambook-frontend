import { canonicalDecimal18_4 } from './decimalInput';

function rateUnits(value: string): bigint {
  const text = value.trim();
  if (!/^\d+(?:\.\d{1,8})?$/.test(text)) throw new Error('汇率须填写正数，最多八位小数。');
  const [whole, fraction = ''] = text.split('.');
  if (whole.replace(/^0+/, '').length > 10) throw new Error('汇率整数部分最多十位。');
  const units = BigInt(whole) * BigInt(100000000) + BigInt(fraction.padEnd(8, '0'));
  if (units <= BigInt(0)) throw new Error('汇率须大于零。');
  return units;
}

/** Independent estimate using only explicitly supplied rates; never writes business facts. */
export function calculateExchange(amount: string, fromRateToCny: string, toRateToCny: string): string {
  const exact = canonicalDecimal18_4(amount);
  const [whole, fraction = ''] = exact.split('.');
  const amountUnits = BigInt(whole) * BigInt(10000) + BigInt(fraction.padEnd(4, '0'));
  const from = rateUnits(fromRateToCny), to = rateUnits(toRateToCny);
  const numerator = amountUnits * from;
  let units = numerator / to;
  if ((numerator % to) * BigInt(2) >= to) units += BigInt(1);
  return `${units / BigInt(10000)}.${String(units % BigInt(10000)).padStart(4, '0')}`;
}
