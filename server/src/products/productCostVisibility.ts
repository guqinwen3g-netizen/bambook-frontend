import { hasScope } from '../auth/permissionService';
import type { TokenPayload } from '../auth/service';

/** Product purchase fields only: targets, customer/sample prices and general
 * trimming prices are different facts. Clone output; never rewrite DB rows.
 */
export function maskProductCost<T>(value: T, actor: TokenPayload | null | undefined): T {
  if (hasScope(actor, 'sensitive:cost')) return value;
  const mask = (item: any): any => {
    if (Array.isArray(item)) return item.map(mask);
    if (!item || typeof item !== 'object') return item;
    // Preserve Decimal/Date class instances for the caller's real serializer.
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) return item;
    return Object.fromEntries(Object.entries(item).map(([key, child]) => [key,
      key === 'cost' || (key === 'amount' && item.priceType === 'factory') ? null : mask(child)]));
  };
  return mask(value);
}
