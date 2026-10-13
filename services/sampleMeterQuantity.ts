/** Decimal(18,4) meters; comparisons never round through Number. */
export function meterScaled(value: unknown): bigint | null {
 const match=/^(\d{1,14})(?:\.(\d{1,4}))?$/.exec(String(value??'').trim());
 return match?BigInt(match[1])*10000n+BigInt((match[2]??'').padEnd(4,'0')||'0'):null;
}
export function meterRemaining(original: unknown, returned: unknown) {
 const a=meterScaled(original),b=meterScaled(returned??'0');if(a===null||b===null||a<b)return '未知';
 const value=a-b,fraction=(value%10000n).toString().padStart(4,'0').replace(/0+$/,'');return `${value/10000n}${fraction?'.'+fraction:''}`;
}
