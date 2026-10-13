#!/usr/bin/env node
/**
 * 电池锚位普查（秒级预检）。
 *
 * 为什么单独成一件：`mutation-battery.mjs` 的锚是**逐字面量**匹配的，改一行判据就能让某枚锚
 * 命中 0 次 ⇒ 电池 exit 2。这件事在本仓已经发生四次（v3.63 的 m1/m9/m14、v3.64 的 m11、
 * v3.65 的 m11、v3.70 的 m11/m24），而每次都是**跑到那一枚才发现**——电池一枚要跑一遍判据
 * 单测（约 15s），发现点往往在 6 分钟之后，链整个白跑。
 * ⇒ 把"锚还在不在、是否唯一"提到电池之前，用同一份 `MUTATIONS` 常量当场数一遍。
 *
 * 用法：node scripts/mutation-anchor-audit.mjs
 * 退出码：0 = 每枚锚在 LIB 里恰好命中 1 次；1 = 有锚命中≠1（列出来，先去修锚或改那枚突变）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MUTATIONS } from './mutation-battery.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(ROOT, 'scripts/lib/acceptance-selfcheck.mjs');
const lib = readFileSync(LIB, 'utf8');

const bad = [];
for (const [id, m] of Object.entries(MUTATIONS)) {
  if (typeof m?.from !== 'string' || typeof m?.to !== 'string') { bad.push([id, 'from/to 不是字符串']); continue; }
  const hits = lib.split(m.from).length - 1;
  if (hits !== 1) bad.push([id, `锚命中 ${hits} 次（要恰好 1）`]);
  // `to === from` ⇒ 这枚是空操作（改了行为却什么都没改），必须报错。
  //   ⚠️ 曾经这里写的是"`to` 已存在于 LIB 就报错"，实测被 m7 误伤（它的 `to` 是
  //   `${attrBlind.length}`，本来就在别处合法地出现一次）⇒ 电池还原走的是整文件备份，
  //   不是"把 to 反着换回去"，所以 `to` 在别处出现**不构成风险**。⇒ 判据要窄到真正有害的那种。
  if (m.to === m.from) bad.push([id, 'to 与 from 相同 ⇒ 这枚是空操作']);
}
console.log(`锚位普查：${Object.keys(MUTATIONS).length} 枚 → 命中≠1 的 ${bad.length} 枚`,
  bad.length ? JSON.stringify(bad) : '（全部恰好 1 次）');
process.exit(bad.length ? 1 : 0);
