/**
 * 事件 → 通知 接线覆盖守卫。
 *
 * ── 为什么需要这个守卫 ──
 * 加一个业务事件类型，代码里有**四处**要接线，但只有一处会编译报错：
 *   · `notifications/notificationTemplateEngine.ts` 的 `Record<BusinessEventType, TemplateSpec>`
 *     → **编译期就报错**（好事）
 *   · `notifications/eventBindings.ts` 的 `ALL_BUSINESS_EVENT_TYPES` → **静默漏**
 *   · `config/automationConfig.ts` 的 AUTOMATION_RULES → 静默漏（但只有需要自动化时才该加）
 *   · `events/linkages/index.ts` 的 registerAllLinkages → 静默漏（同上）
 * 于是很容易出现「模板写好了、通知永远不发」的**静默断链** —— 而且
 * `ALL_BUSINESS_EVENT_TYPES` 这个名字本身就在骗人：它并不是「全部」。
 *
 * ── 本守卫的形态：棘轮（ratchet），不是全绿 ──
 * 现存断链是**历史存量**，本轮不做行为变更（哪些通知该发、哪些会变成噪声，属业务口径）。
 * 所以这里只冻结**基线名单**：存量允许，**新增一律不许**。
 * 将来要修存量，删掉基线里对应行即可（删了就说明接通了）。
 *
 * 检测启发式（够用即可，别当精确解析器）：
 *   · 模板键 = notificationTemplateEngine 里 `^  XxxYyy: {` 形态的键
 *   · 已订阅 = eventBindings 里 ALL_BUSINESS_EVENT_TYPES 数组内的字符串字面量
 *   · 有发布点 = 全仓 src（去掉 *.test.ts）出现 `type: 'XxxYyy'`
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '..', '..');

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue;
      walk(full, acc);
    } else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

const templateKeys = (): string[] => {
  const src = readFileSync(path.join(SRC, 'notifications/notificationTemplateEngine.ts'), 'utf-8');
  return [...src.matchAll(/^ {2}([A-Z][A-Za-z]+): \{/gm)].map(m => m[1]);
};

const subscribedTypes = (): Set<string> => {
  const src = readFileSync(path.join(SRC, 'notifications/eventBindings.ts'), 'utf-8');
  const start = src.indexOf('ALL_BUSINESS_EVENT_TYPES');
  const block = src.slice(start, src.indexOf('];', start));
  return new Set([...block.matchAll(/'([A-Za-z]+)'/g)].map(m => m[1]));
};

const publishedTypes = (): Set<string> => {
  const out = new Set<string>();
  for (const f of walk(SRC)) {
    const src = readFileSync(f, 'utf-8');
    for (const m of src.matchAll(/type:\s*'([A-Za-z]+)'/g)) out.add(m[1]);
  }
  return out;
};

/**
 * 已知存量断链（模板在、有发布点、但未订阅）—— **冻结基线，只许减不许增**。
 * 修好一条就删一行；新增事件若落进这个集合，下面的断言会红。
 */
const KNOWN_UNSUBSCRIBED_BASELINE = [
  'QuotationIssued',
  'QuotationAccepted',
  'PurchaseOrderSent',
  'PurchaseOrderConfirmed',
  'MaterialReceived',
  'StockLowAlarm',
  'StockOverstockAlarm',
  'BOMConfirmed',
  'BOMCostCalculated',
  'ProformaInvoiceGenerated',
  'ProformaInvoiceConverted',
  'SupplierBlacklisted',
  'FactoryEvaluationAdded',
];

describe('事件 → 通知 接线覆盖（棘轮守卫）', () => {
  it('★ 有发布点却未订阅的事件类型，不得超出冻结基线（新增会红）', () => {
    const tpl = templateKeys();
    const subs = subscribedTypes();
    const pub = publishedTypes();
    const gap = tpl.filter(k => pub.has(k) && !subs.has(k)).sort();
    const baseline = [...KNOWN_UNSUBSCRIBED_BASELINE].sort();

    const newlyGapped = gap.filter(k => !baseline.includes(k));
    expect(newlyGapped, `新事件有发布点但未订阅（通知永远不发）：${newlyGapped.join('、')}\n`
      + '→ 在 notifications/eventBindings.ts 的 ALL_BUSINESS_EVENT_TYPES 里补上；'
      + '若确定不该发通知，请连同理由加进本文件的 KNOWN_UNSUBSCRIBED_BASELINE。').toEqual([]);

    // 基线里的条目若已被修好（不再断链），提醒删行（避免基线腐化）
    const alreadyFixed = baseline.filter(k => !gap.includes(k));
    expect(alreadyFixed, `基线里这些已不再是断链，请从 KNOWN_UNSUBSCRIBED_BASELINE 删掉：${alreadyFixed.join('、')}`).toEqual([]);
  });

  it('L2 高危 3 号 ThirdPartyPaymentDetected：模板 + 订阅都必须在（防「模板在、订阅漏」）', () => {
    expect(templateKeys()).toContain('ThirdPartyPaymentDetected');
    expect([...subscribedTypes()]).toContain('ThirdPartyPaymentDetected');
  });
});
