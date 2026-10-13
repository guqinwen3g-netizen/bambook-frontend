/**
 * seed-sequence.ts — Phase 0-03 编号发号器幂等初始化
 *
 * 运行：
 *   cd server && npx ts-node scripts/seed-sequence.ts
 *
 * 行为（幂等，可反复运行）：
 *   1. 为 11 类 SequenceType 在 SequenceRegister 表预创建当前周期行：
 *      - 按年：year=当前年 2026
 *      - 按月：year=当前年+month=当前月 2026-08
 *      - 永久：__global__
 *      即使不跑 seed，nextNumber 首次调用也会 upsert；跑 seed 的意义是
 *      让 peekNextNumber / listStatuses 查询在首次分配前就有完整状态。
 *   2. 为上一年（2025 → 2026 跨年）提前准备 year=明年 的种子行（可选，预填）
 *   3. 控制台输出统计
 */
import { PrismaClient } from '@prisma/client';
import {
  SEQUENCE_TYPE_CONFIGS,
  ALL_SEQUENCE_TYPES,
  periodKeyForDate,
  type SequenceType,
  type SequencePeriod,
} from '../src/sequence/sequenceService';

const prisma = new PrismaClient();

function buildPeriodKeysForSeeding(period: SequencePeriod, now: Date): string[] {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  switch (period) {
    case 'year':
      // 当前年 + 下一年（跨年时不用临时补行）
      return [String(y), String(y + 1)];
    case 'month':
      // 当前月 + 下一月 + 最后两月保底
      const keys: string[] = [];
      for (let delta = 0; delta <= 2; delta++) {
        const dt = new Date(y, m - 1 + delta, 1);
        keys.push(periodKeyForDate('month', dt)); // YYYY-MM
      }
      return keys;
    case 'day':
      return [periodKeyForDate('day', now)];
    case 'none':
    default:
      return ['__global__'];
  }
}

async function seedOneType(seqType: SequenceType): Promise<{ created: number; skipped: number; type: SequenceType }> {
  const cfg = SEQUENCE_TYPE_CONFIGS[seqType];
  const periodKeys = buildPeriodKeysForSeeding(cfg.period, new Date());
  let created = 0;
  let skipped = 0;
  for (const periodKey of periodKeys) {
    const id = `SEQREG_${seqType}_${periodKey}`;
    const existing = await prisma.sequenceRegister.findUnique({ where: { id }, select: { id: true } });
    if (existing) {
      skipped++;
      continue;
    }
    await prisma.sequenceRegister.upsert({
      where: { id },
      create: {
        id,
        seqType,
        period: cfg.period,
        periodKey,
        prefix: cfg.prefix,
        formatTemplate: cfg.defaultFormatTemplate,
        padding: cfg.defaultPadding,
        startSeq: 1,
        currentSeq: 0,
        updatedAt: BigInt(Date.now()),
        description: cfg.description,
      },
      update: {},
    });
    created++;
  }
  return { created, skipped, type: seqType };
}

async function main() {
  console.log(`[seed-sequence] Start. Types=${ALL_SEQUENCE_TYPES.length}.`);
  let totalCreated = 0;
  let totalSkipped = 0;
  for (const st of ALL_SEQUENCE_TYPES) {
    const res = await seedOneType(st);
    totalCreated += res.created;
    totalSkipped += res.skipped;
    console.log(`  - ${res.type.padEnd(10)}: created=${res.created}, skipped=${res.skipped} (prefix=${SEQUENCE_TYPE_CONFIGS[st].prefix}, period=${SEQUENCE_TYPE_CONFIGS[st].period})`);
  }
  console.log(`[seed-sequence] Done. totalCreated=${totalCreated}, totalSkipped=${totalSkipped}.`);
  console.log('[seed-sequence] 11 SequenceType baseline rows ensured.');
}

main()
  .catch((err) => {
    console.error('[seed-sequence] FAILED:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
