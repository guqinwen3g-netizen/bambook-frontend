/**
 * 溢出 / 贴边叠放判定自检：用固定的 HTML 夹具验证 detectOverflow、detectStacking 能抓到每类问题、不误报正常布局。
 * 快速回归与全量扫描开始前都会先跑一遍，判定逻辑被改坏时直接失败，避免「0 溢出」是假阴性。
 */
import { detectOverflow, detectStacking } from './detect.mjs';

const W = 'style="width:200px;font:14px/1.4 sans-serif"';
export const FIXTURES = [
  { name: '正常布局', expect: [], html: `<div ${W}><div style="display:flex;gap:8px"><span style="min-width:0;overflow-wrap:anywhere">很长很长很长很长很长很长很长很长的名称</span><b style="flex:none">12.00</b></div></div>` },
  { name: 'flex 子项不收缩', expect: ['overflow-x'], html: `<div ${W}><div style="display:flex"><span style="white-space:nowrap">SO-F-2026-0006 · 已批准待履约 · 很长的说明</span></div></div>` },
  { name: '裁切不显示省略', expect: ['clipped-x'], html: `<div ${W}><div style="overflow:hidden;white-space:nowrap"><b>订单履约 / 开发与寻样 / 新建开发案</b></div></div>` },
  { name: '未设计的横向滚动', expect: ['scroll-x-undesigned'], html: `<div ${W}><div style="overflow-x:auto;display:flex"><button style="flex:none;width:160px">A</button><button style="flex:none;width:160px">B</button></div></div>` },
  { name: '按设计的横向滚动', expect: [], designed: 1, html: `<div ${W}><div data-mist-scroll="x" style="overflow-x:auto;display:flex"><button style="flex:none;width:160px">A</button><button style="flex:none;width:160px">B</button></div></div>` },
  { name: '省略号无全文', expect: ['truncate-no-full-text'], html: `<div ${W}><span style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">INV-G-2026-0398 Northwind Atelier Ltd.</span></div>` },
  { name: '省略号带 title', expect: [], html: `<div ${W}><span title="INV-G-2026-0398 Northwind Atelier Ltd." style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">INV-G-2026-0398 Northwind Atelier Ltd.</span></div>` },
  { name: '绝对定位标注不算溢出', expect: [], html: `<div ${W}><div style="position:relative;height:20px"><i style="position:absolute;left:190px;width:2px;height:8px"><b style="position:absolute;left:4px;white-space:nowrap">今天 · 很长的标注</b></i></div></div>` },
  { name: '卡片贴边叠放', stack: true, expect: ['stack-touching'], html: `<div ${W}><article style="background:#eee;border-radius:12px;height:40px"></article><article style="background:#eee;border-radius:12px;height:40px"></article></div>` },
  { name: '卡片包裹层内贴边叠放', stack: true, expect: ['stack-touching'], html: `<div ${W}><div><article style="background:#eee;border-radius:12px;height:40px"></article></div><div><article style="background:#eee;border-radius:12px;height:40px"></article></div></div>` },
  { name: '卡片有间距', stack: true, expect: [], html: `<div style="width:200px;display:flex;flex-direction:column;gap:12px"><article style="background:#eee;border-radius:12px;height:40px"></article><article style="background:#eee;border-radius:12px;height:40px"></article></div>` },
  { name: '有意拼接的分组', stack: true, expect: [], html: `<div ${W}><div style="background:#eee;border-radius:12px 12px 0 0;height:40px"></div><div style="background:#eee;border-radius:0 0 12px 12px;height:40px"></div></div>` },
  { name: '只有分隔线的列表行', stack: true, expect: [], html: `<div ${W}><button style="display:block;width:100%;border:0;border-radius:12px;height:40px;background:none"></button><button style="display:block;width:100%;border:0;border-top:1px solid #ccc;border-radius:12px;height:40px;background:none"></button></div>` },
  { name: '整页横向滚动', expect: ['page-scroll-x'], width: 360, html: `<div style="width:520px;height:20px"></div>` },
];

export async function selfTest(page) {
  const failures = [];
  for (const f of FIXTURES) {
    await page.setViewportSize({ width: f.width ?? 800, height: 400 });
    await page.setContent(`<!doctype html><html><body style="margin:0">${f.html}</body></html>`);
    const result = f.stack ? { ...(await page.evaluate(detectStacking, {})), designed: [] } : await page.evaluate(detectOverflow, {});
    const kinds = [...new Set(result.issues.map(i => i.kind))].sort();
    const want = [...f.expect].sort();
    const ok = JSON.stringify(kinds) === JSON.stringify(want) && (f.designed == null || result.designed.length === f.designed);
    if (!ok) failures.push(`${f.name}：期望 [${want.join(', ')}]${f.designed != null ? ` + ${f.designed} 个按设计滚动` : ''}，实际 [${kinds.join(', ')}]，按设计滚动 ${result.designed.length}`);
  }
  return failures;
}
