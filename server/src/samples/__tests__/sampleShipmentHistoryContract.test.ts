/**
 * sampleShipmentHistoryContract.test.ts — ★ C5 结构守卫：三个寄样入口 ⟺ 一条读路径
 *
 * 为什么要有（零基础障碍清单 C5「分批寄样」）：
 *   本仓有**三个寄样入口**，历史上只有早产样支持分批寄样（其余两个是覆盖式）。
 *   C5 把后两者对齐成追加式 —— 这类"同一业务动作多个入口"的改动，最怕**漏收**：
 *   只改了其中一个入口，另一个仍在覆盖，而**真库演练只测了其中一个**就全绿（假绿）。
 *   ⇒ 用**源码扫描 + 计数对撞**把「三个入口都必须追加」钉死。
 *
 * 判据：
 *   ① 三个入口都调用 `appendShipmentHistory(`（漏一个即红）
 *   ② ★ 成衣轮次是**白名单持久化** ⇒ 写侧 `att` 与读侧 `serialize` **都必须含 `shipmentHistory`**
 *      （只改一处 = 历史被静默丢弃 —— 这是本次差点踩到的坑）
 *   ③ 读路径三主体齐全（fabric/garment/early），且各读各的 Json 字段
 *   ④ 路由存在且 subject 有白名单校验
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const srcRoot = path.resolve(process.cwd(), 'src');
const read = (rel: string) => fs.readFileSync(path.join(srcRoot, rel), 'utf-8');

const FABRIC = read('samples/fabricShipmentSampleService.ts');
const GARMENT = read('samples/garmentSampleGateService.ts');
const EARLY = read('samples/earlyProductionSampleService.ts');
const READER = read('samples/sampleShipmentHistoryService.ts');
const ROUTE = read('samples/sampleRoute.ts');

describe('★ C5 结构守卫：寄样入口与读路径', () => {
  it('① 三个寄样入口都要「追加历史」（漏一个 = 那个入口仍只留最后一次）', () => {
    expect(FABRIC).toContain('appendShipmentHistory(');
    expect(GARMENT).toContain('appendShipmentHistory(');
    // 早产样用的是自己的 rounds[] 追加模式（既有实现，等价于"追加"）—— 记录在案而非要求改写
    expect(EARLY).toMatch(/rounds: \[\.\.\.\(\(sample\.attachments as any\)\?\.rounds \?\? \[\]\), roundEntry\]/);
  });

  it('② ★ 成衣轮次是白名单持久化：写侧 att 与读侧 serialize **都要含** shipmentHistory', () => {
    // 写侧：persistRounds 的 att 对象
    const attBlock = GARMENT.slice(GARMENT.indexOf('const att: any = {'), GARMENT.indexOf('const statusMap'));
    expect(attBlock, '写侧白名单缺 shipmentHistory ⇒ 历史会被静默丢弃').toContain('shipmentHistory');
    // 读侧：serializeGarmentRound 的返回
    const serBlock = GARMENT.slice(GARMENT.indexOf('function serializeGarmentRound'), GARMENT.indexOf('function persistRounds'));
    expect(serBlock, '读侧白名单缺 shipmentHistory ⇒ 写进去了也读不出来').toContain('shipmentHistory');
  });

  it('③ 读路径三主体齐全，且各读各的 Json 字段', () => {
    expect(READER).toContain("subject === 'fabric'");
    expect(READER).toContain("subject === 'garment'");
    // 三个 Json 字段路径（与写侧一致）
    expect(READER).toContain('attachments?.shipments');        // fabric
    expect(READER).toContain('attachments?.shipmentHistory');  // garment
    expect(READER).toContain('attachments?.rounds');           // early
  });

  it('④ 路由存在且 subject 有白名单校验（防拼错 subject 静默返回空历史）', () => {
    expect(ROUTE).toContain("router.get('/shipment-history/:subject/:id'");
    expect(ROUTE).toContain("['fabric', 'garment', 'early'].includes(subject)");
    expect(ROUTE).toContain('INVALID_SUBJECT');
  });

  it('⑤ 读路径必须复用真源（取最后一次/费用合计不得各写一套）', () => {
    expect(READER).toContain("from './sampleShipmentHistory'");
    expect(READER).toContain('latestShipmentOf(');
    expect(READER).toContain('totalShippingFeeOf(');
  });
});
