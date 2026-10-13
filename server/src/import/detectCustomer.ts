import { DetectionResult } from './types';

interface Rule {
  customerId: string;
  weight: number;
  pattern: RegExp;
  reason: string;
}

const RULES: Rule[] = [
  { customerId: 'peerless', weight: 0.5, pattern: /V[êe]tements Peerless Clothing Inc\./i, reason: 'legal name' },
  { customerId: 'peerless', weight: 0.3, pattern: /T\.V\.Q\.\/Q\.S\.T\. No 1000873531/i, reason: 'QST tax id' },
  { customerId: 'peerless', weight: 0.2, pattern: /T\.P\.S\.\/G\.S\.T\. No\. 104128616/i, reason: 'GST tax id' },
  { customerId: 'peerless', weight: 0.2, pattern: /Sonya Catalano\/514-593-9300/i, reason: 'Peerless contact' },
  { customerId: 'peerless', weight: 0.1, pattern: /\b4500\d{6}\b/, reason: 'Peerless PO number pattern' },
];

export function detectCustomer(text: string): DetectionResult {
  const scores = new Map<string, { score: number; reasons: string[] }>();
  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      const cur = scores.get(rule.customerId) ?? { score: 0, reasons: [] };
      cur.score += rule.weight;
      cur.reasons.push(rule.reason);
      scores.set(rule.customerId, cur);
    }
  }
  let bestId: string | null = null;
  let best = { score: 0, reasons: [] as string[] };
  for (const [id, s] of scores) {
    if (s.score > best.score) {
      best = s;
      bestId = id;
    }
  }
  return {
    customerId: bestId,
    confidence: Math.min(1, best.score),
    reasons: best.reasons,
  };
}
