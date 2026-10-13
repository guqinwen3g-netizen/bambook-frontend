#!/usr/bin/env node
// ═══ BDS 退役项迁移守卫（基线模式，只减不增） ═══
// 2026-10-09 SKILL「结构与动作总纲」D1 按钮三档制：outline/ghost/dark/sm 档位退役，
// 行内动作一律收编为无容器 inline 动作。dark/sm 已由 check-design-tokens.sh M5/M2 守卫，
// 本脚本收编 outline/ghost 存量：存量允许（随逐页迁移清零），【新增使用】= 违规。
// 用法：node scripts/check-migration.mjs ；CI 集成：npm run check:migration
import { execFileSync } from 'node:child_process';

// ── 退役类黑名单（出处：SKILL.md 结构与动作总纲 1 / bds-assets.md「全局按钮三档制」）──
const RETIRED = [
  // 基线建仓 2026-10-10 实测（rg -o，components/*.tsx 排除测试；只减不增）
  { cls: 'bds-btn-outline', baseline: 135 },
  { cls: 'bds-btn-ghost', baseline: 428 },
];

const RG_GLOBS = ['--glob', '*.tsx', '--glob', '!*.test.*', '--glob', '!**/__tests__/**', '--glob', '!**/node_modules/**'];

function countOccurrences(cls) {
  try {
    const out = execFileSync('rg', ['-o', cls, ...RG_GLOBS, 'components'], { encoding: 'utf8' });
    return out.split('\n').filter(Boolean).length;
  } catch {
    return 0; // rg 无匹配退出码 1 = 0 处
  }
}

function sampleOccurrences(cls, limit = 10) {
  try {
    const out = execFileSync('rg', ['-n', cls, ...RG_GLOBS, 'components'], { encoding: 'utf8' });
    return out.split('\n').filter(Boolean).slice(0, limit).join('\n');
  } catch {
    return '';
  }
}

let errors = 0;
console.log('═══ BDS 退役项迁移守卫（check:migration）═══');
console.log('');
for (const { cls, baseline } of RETIRED) {
  const current = countOccurrences(cls);
  if (current > baseline) {
    console.error(`  ❌ ${cls} 新增使用（基线 ${baseline} → 当前 ${current}）`);
    console.error('     该档位已退役（SKILL 结构与动作总纲 D1）：新代码用 bds-btn-primary / bds-secondary-action / 无容器 inline 动作');
    const sample = sampleOccurrences(cls);
    if (sample) console.error(sample);
    errors += 1;
  } else if (current < baseline) {
    console.log(`  ✅ ${cls} 存量减少（基线 ${baseline} → 当前 ${current}）— 恭喜！请更新基线。`);
  } else {
    console.log(`  ✅ ${cls} 维持基线（${current} 处，逐页迁移清零对象）`);
  }
}
console.log('');
if (errors > 0) {
  console.error(`❌ 退役项迁移守卫：${errors} 类新增使用（基线模式只减不增，更新基线须在 commit 中说明）`);
  process.exit(1);
}
console.log('✅ 退役项迁移守卫通过（基线模式 · 按钮三档制 D1）');
