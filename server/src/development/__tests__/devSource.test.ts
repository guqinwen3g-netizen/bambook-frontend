/**
 * G-5 批：开发来源（`DevelopmentCase.source`）真源收敛的守卫。
 *
 * 本批判到的不是"缺功能"，而是**四份并行真源 + 一处把已录的值销毁**（逐条 file:line 见 devSource.ts 头注释）。
 * 所以这里的重心是"两份不可能再各说各话"，而不是"函数返回对不对"：
 *   ① 映射表本身（行为，可证伪）；
 *   ② **两条转档链都查这一份**（面料/成衣各自源码里不许再出现字面量映射）；
 *   ③ 前端的选项与文案来自同一个 import（本仓最容易复发的形状就是"UI 又抄一份"）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ASSET_SOURCE_DEFAULT, DEV_CONVERTED_ASSET_SOURCES, DEV_SOURCES, DEV_SOURCE_LABELS,
  DEV_SOURCE_OPTIONS, DEV_SOURCE_ORDER, assetSourceFromDevCase, devSourceLabel, isDevConvertedAssetSource,
} from '../devSource';

const HERE = path.dirname(fileURLToPath(import.meta.url));       // server/src/development/__tests__
const REPO = path.resolve(HERE, '..', '..', '..', '..');          // 仓库根
/** 剥掉注释：注释里写「已接真源」不算数（与 lcGateWiring 同一手法） */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const readRepo = (rel: string) => strip(fs.readFileSync(path.join(REPO, rel), 'utf8'));

describe('开发来源 · 映射表（DR-054 阶段 D 既有口径，逐字搬来不改数值）', () => {
  it('三个取值各自的落点：internal→development、两种客户来源→customer_sample', () => {
    expect(assetSourceFromDevCase('internal')).toBe('development');
    expect(assetSourceFromDevCase('customer-sample')).toBe('customer_sample');
    expect(assetSourceFromDevCase('customer-colorcard')).toBe('customer_sample');
  });

  it('★ 无值/脏值一律默认，且**不许把脏值原样当 asset.source 写出去**', () => {
    for (const bad of [null, undefined, '', '   ', '客户来样', 'CUSTOMER-SAMPLE', 'customer_sample']) {
      expect(assetSourceFromDevCase(bad), `source=${JSON.stringify(bad)} 应落默认值`).toBe(ASSET_SOURCE_DEFAULT);
    }
    // 恒不匹配自检：判据不是"恒返回默认值"（那样上面全绿也没有守卫）
    expect(assetSourceFromDevCase('customer-sample')).not.toBe(ASSET_SOURCE_DEFAULT);
  });

  it('集合、文案、下拉三者不许各说各话（下拉由顺序 + 值集合**派生**，不是手抄）', () => {
    expect([...DEV_SOURCES].sort()).toEqual(['customer-colorcard', 'customer-sample', 'internal']);
    // ★ 顺序集合必须**恰好等于**值集合：少一个值 = 下拉里选不到（静默丢功能），多一个值 = 能选到非法值
    expect([...DEV_SOURCE_ORDER].sort()).toEqual([...DEV_SOURCES].sort());
    for (const v of DEV_SOURCES) {
      expect(DEV_SOURCE_LABELS[v as keyof typeof DEV_SOURCE_LABELS], `${v} 缺文案`).toBeTruthy();
      expect(DEV_SOURCE_OPTIONS.some((o) => o.value === v), `${v} 没进下拉`).toBe(true);
    }
    expect(DEV_SOURCE_OPTIONS[0].value, '首项必须是「不指定」（不写 source）').toBe('');
    expect(DEV_SOURCE_OPTIONS.length, 'options 只许"不指定 + 三个值"').toBe(4);
    expect(devSourceLabel('customer-sample')).toBe(DEV_SOURCE_LABELS['customer-sample']);
    expect(devSourceLabel('customer-request')).toBe('客户要求开发');
    expect(devSourceLabel('internal-request')).toBe('内部发起开发');
    for (const alias of ['customer-request', 'internal-request']) {
      expect(DEV_SOURCE_OPTIONS.some(option => String(option.value) === alias)).toBe(false);
      expect(assetSourceFromDevCase(alias)).toBe(ASSET_SOURCE_DEFAULT);
    }
    expect(devSourceLabel('乱写的值'), '不认识的值原样回显（脏数据要看得见）').toBe('乱写的值');
    expect(devSourceLabel(null)).toBeNull();
  });

  it('★ 文案措辞也要钉（D76 拍的是"两份漂字里取哪一份"，只钉存在性等于没钉这个决定）', () => {
    expect(DEV_SOURCE_LABELS).toEqual({
      'customer-sample': '客户来样开发',
      'customer-colorcard': '客户色卡/规格开发',
      internal: '内部开发（本司部门提出）',
    });
    // 下拉里显示的必须是同一份字符串（派生关系一旦退回手抄，这里当场红）
    for (const o of DEV_SOURCE_OPTIONS.filter((x) => x.value !== '')) {
      expect(o.label).toBe(DEV_SOURCE_LABELS[o.value as keyof typeof DEV_SOURCE_LABELS]);
    }
  });

  it('★ 「哪些 ProductAsset.source 算开发转档」= 映射表值域 + 默认值（复核抓到：判据写死 development 会让跳转链接静默消失）', () => {
    expect([...DEV_CONVERTED_ASSET_SOURCES].sort()).toEqual(['customer_sample', 'development']);
    expect(isDevConvertedAssetSource('development')).toBe(true);
    expect(isDevConvertedAssetSource('customer_sample')).toBe(true);
    // 反向对照：手动录入/来源不明/空值都不许被认成"能跳开发案"（那会做出点了没结果的死链）
    for (const v of ['manual', 'customer_sample_extra', 'DEVELOPMENT', '', '   ', null, undefined]) {
      expect(isDevConvertedAssetSource(v as any), `${JSON.stringify(v)} 不该被认成开发转档`).toBe(false);
    }
    // 口径与 assetSourceFromDevCase 一致：**忽略首尾空格、区分大小写**（' development' 是同一个值，'DEVELOPMENT' 不是）
    expect(isDevConvertedAssetSource(' development')).toBe(true);
  });
});

describe('开发来源 · 两条转档链必须查同一份真源（本批的病灶就在成衣侧硬编码）', () => {
  it('① 面料侧：改引 assetSourceFromDevCase，本地那份 DEV_SOURCE_MAP 字面量已删', () => {
    const src = readRepo('server/src/development/fabricDevelopmentService.ts');
    // Conversion now reads the freshly locked case rather than the preflight
    // object; both import and actual assignment remain pinned to the one map.
    expect(src).toMatch(/const\s+liveCase\s*=\s*await\s+findLiveCase\(tx,\s*caseId\)/);
    expect(src).toMatch(/assetSourceFromDevCase\(liveCase\.source\)/);
    expect(src).not.toMatch(/const DEV_SOURCE_MAP/);
    // 那枚"声明后全仓零引用"的 DEV_SOURCES 副本（连 re-export 版都算）**不许复活**：
    //   零引用的出口本身就是下一份漂字的温床，取值集合只认 devSource.ts 那一处。
    expect(src).not.toMatch(/DEV_SOURCES/);
  });

  it('② 成衣侧：同样查真源，且源码里**不许再有 assetSource = 字面量**（那就是销毁已录来源的那一行）', () => {
    const src = readRepo('server/src/development/garmentDevelopmentService.ts');
    expect(src).toMatch(/assetSourceFromDevCase\(devCase\.source\)/);
    // 反引号/单引号/双引号三种字面量都要咬住（复核指出：只排 ['\"] 的写法会被 `customer_sample` 绕过）
    expect(src).not.toMatch(/const\s+assetSource\s*=\s*['"`]/);
  });

  it('③ 前端：选项与文案来自 import，本文件不许再抄一份标签表', () => {
    const src = readRepo('components/DevelopmentManager.tsx');
    expect(src).toMatch(/import \{ DEV_SOURCE_OPTIONS, devSourceLabel \} from '\.\.\/server\/src\/development\/devSource'/);
    expect(src).not.toMatch(/const DEV_SOURCE_LABELS/);
    expect(src).toMatch(/options=\{DEV_SOURCE_OPTIONS\}/);
    // 档案详情"跳转到开发案"的判据必须走同源谓词（复核抓到：写死 development 会让带来源的档案静默退化）
    const pm = readRepo('components/ProductsManager.tsx');
    expect(pm).toMatch(/isDevConvertedAssetSource\(product\.source\)/);
    expect(pm).not.toMatch(/product\.source === 'development'/);
    // 反向对照：证明这条判据认得"又抄一份"的写法（否则上面的 not.toMatch 是恒真）
    expect(/const DEV_SOURCE_LABELS: Record<string, string> = \{/.test(
      "const DEV_SOURCE_LABELS: Record<string, string> = { internal: 'x' };",
    ), '抄一份的写法必须能被扫到').toBe(true);
  });
});
