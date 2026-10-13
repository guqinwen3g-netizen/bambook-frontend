import { describe, expect, it } from 'vitest';
import { getOrderStatusDot } from './orderStatusVisuals';

describe('getOrderStatusDot', () => {
  it('maps order status to the compact table status dot', () => {
    expect(getOrderStatusDot('Delivered')).toBeNull();
    expect(getOrderStatusDot('Pending')?.tone).toBe('neutral');
    expect(getOrderStatusDot('Production')?.tone).toBe('blue');
    expect(getOrderStatusDot('Shipping')?.tone).toBe('green');
    expect(getOrderStatusDot('Alert')?.tone).toBe('red');
  });

  it('keeps status dots as pure filled circles without outline classes', () => {
    for (const status of ['Pending', 'Production', 'Shipping', 'Alert'] as const) {
      const visual = getOrderStatusDot(status);
      expect(visual?.className).not.toContain('ring-');
      expect(visual?.className).not.toContain('border');
    }
  });
});
