/**
 * 浏览器内执行的溢出判定（由 Playwright `page.evaluate(detectOverflow, options)` 注入，必须自包含）。
 *
 * 判定规则（与 PR 说明一致）：
 *  1. 非滚动容器（overflow-x: visible / hidden / clip）的内容宽度大于容器宽度 → 溢出（被裁掉或盖住旁边内容）。
 *     只报告最内层的问题容器，并给出最突出的那个子元素 / 文字（culprit）。
 *  2. 可滚动容器（overflow-x: auto / scroll）出现横向滚动，但它和祖先都没有标注 `data-mist-scroll="x"` → 未设计的横向滚动。
 *     标注过的算「按设计横向滚动」，单独列出，不算问题。整页横向滚动一律算问题。
 *  3. 故意截断（text-overflow: ellipsis 或 -webkit-line-clamp）：本元素或祖先带 title / aria-label 能看到全文 → 不算；否则算「截断但看不到全文」。
 *  4. overflow-y 裁切容器内容高于容器（排除 line-clamp 与折叠动画中的 0 高度容器）→ 纵向裁切。
 *  忽略：不可见元素、绝对 / 固定定位的子元素（浮层、角标、装饰）、图片 / svg / canvas 等装饰性媒体、宽高 ≤ 1px 的读屏专用文字。
 */
export function detectOverflow(options = {}) {
  const TOL = options.tolerance ?? 1;
  const MAX_ISSUES = options.maxIssues ?? 400;
  const vw = document.documentElement.clientWidth;
  const issues = [], designed = [];
  const MEDIA = new Set(['IMG', 'SVG', 'svg', 'CANVAS', 'VIDEO', 'IFRAME', 'PICTURE', 'path', 'circle', 'g']);
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'HEAD', 'META', 'LINK', 'BR', 'WBR', 'OPTION']);
  const styleOf = new Map();
  const cs = el => { let s = styleOf.get(el); if (!s) { s = getComputedStyle(el); styleOf.set(el, s); } return s; };
  const visible = el => {
    if (!(el instanceof Element)) return false;
    const s = cs(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return false;
    if (!el.getClientRects().length) return false;
    if (el.closest('details:not([open]) > :not(summary)')) return false;
    return true;
  };
  const describe = el => {
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 6; depth++, node = node.parentElement) {
      let part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(part + '#' + node.id); break; }
      const classes = [...node.classList].filter(c => !/^(is-|_|css-)/.test(c)).slice(0, 2);
      if (classes.length) part += '.' + classes.join('.');
      const role = node.getAttribute('role');
      if (role && !['presentation', 'none'].includes(role)) part += `[role=${role}]`;
      const data = [...node.attributes].find(a => a.name.startsWith('data-') && !['data-density', 'data-clickable', 'data-hide-sm', 'data-tone'].includes(a.name) && a.value.length < 24);
      if (data) part += `[${data.name}${data.value ? '=' + data.value : ''}]`;
      parts.unshift(part);
      if (node.classList.contains('mist-scroll') || node.classList.contains('mist-canvas') || node.getAttribute('role') === 'dialog') break;
    }
    return parts.join(' > ');
  };
  const snippet = node => (node?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const rectOf = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
  const hasFullText = el => !!(el.closest('[title],[aria-label],[data-full-text]'));
  const designedScroll = el => !!el.closest('[data-mist-scroll~="x"]');
  const inlineLike = d => d === 'inline' || d === 'contents' || d === 'table-row' || d === 'table-row-group' || d === 'table-header-group' || d === 'table-column';

  /** 找出在 el 内容区右侧最突出的子元素或文字。 */
  const culprit = (el, axis) => {
    const box = el.getBoundingClientRect();
    const s = cs(el);
    const limit = axis === 'x' ? box.right - parseFloat(s.borderRightWidth) - (axis === 'x' ? 0 : 0) : box.bottom - parseFloat(s.borderBottomWidth);
    let best = null, bestOver = TOL;
    // 不可见、绝对 / 固定定位的子树整体跳过（浮层、角标、标注文字不参与布局，不算溢出）。
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: n => n.nodeType === 3 ? NodeFilter.FILTER_ACCEPT
        : (!visible(n) || ['absolute', 'fixed'].includes(cs(n).position)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    let count = 0;
    for (let n = walker.nextNode(); n && count < 1500; n = walker.nextNode(), count++) {
      let r;
      if (n.nodeType === 3) {
        if (!n.textContent.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(n); r = range.getBoundingClientRect();
      } else {
        r = n.getBoundingClientRect();
      }
      if (!r.width && !r.height) continue;
      const over = axis === 'x' ? r.right - limit : r.bottom - limit;
      if (over > bestOver) { bestOver = over; best = n; }
    }
    if (!best) return null;
    const target = best.nodeType === 3 ? best.parentElement : best;
    return { selector: describe(target), text: snippet(best), over: Math.round(bestOver), media: MEDIA.has(target.tagName) || !!target.closest('svg') };
  };

  const page = document.scrollingElement || document.documentElement;
  if (page.scrollWidth > vw + TOL) {
    const widest = [...document.body.querySelectorAll('*')].filter(e => visible(e) && !['absolute', 'fixed'].includes(cs(e).position)).map(e => [e, e.getBoundingClientRect().right]).filter(([, r]) => r > vw + TOL).sort((a, b) => a[1] - b[1]).pop();
    issues.push({ kind: 'page-scroll-x', selector: 'html', over: page.scrollWidth - vw, culprit: widest ? { selector: describe(widest[0]), text: snippet(widest[0]), over: Math.round(widest[1] - vw) } : null, rect: { x: 0, y: 0, w: vw, h: 0 } });
  }

  const flagged = [];
  const all = document.body.getElementsByTagName('*');
  for (const el of all) {
    if (SKIP_TAGS.has(el.tagName) || MEDIA.has(el.tagName) || el.closest('svg')) continue;
    if (!visible(el)) continue;
    const s = cs(el);
    if (inlineLike(s.display)) continue;
    const cw = el.clientWidth, ch = el.clientHeight;
    if (cw <= 1 && ch <= 1) continue;
    const ox = s.overflowX, oy = s.overflowY;
    const overX = el.scrollWidth - cw, overY = el.scrollHeight - ch;
    const ellipsis = s.textOverflow === 'ellipsis' && (ox === 'hidden' || ox === 'clip');
    const clamp = s.webkitLineClamp && s.webkitLineClamp !== 'none' && (oy === 'hidden' || oy === 'clip');
    if (overX > TOL && cw > 1) {
      if (ox === 'auto' || ox === 'scroll') {
        if (el === document.documentElement || el === document.body) continue;
        const entry = { selector: describe(el), over: overX, rect: rectOf(el) };
        if (designedScroll(el)) designed.push(entry); else flagged.push({ el, kind: 'scroll-x-undesigned', axis: 'x', over: overX });
      } else if (ellipsis) {
        if (!hasFullText(el)) flagged.push({ el, kind: 'truncate-no-full-text', axis: 'x', over: overX });
      } else {
        flagged.push({ el, kind: ox === 'visible' ? 'overflow-x' : 'clipped-x', axis: 'x', over: overX });
      }
    }
    if (overY > TOL && ch > 2 && (oy === 'hidden' || oy === 'clip')) {
      if (clamp) { if (!hasFullText(el)) flagged.push({ el, kind: 'truncate-no-full-text', axis: 'y', over: overY }); }
      else if (!s.transition.includes('grid-template-rows') && !(el.parentElement && /grid-template-rows/.test(cs(el.parentElement).transition))) flagged.push({ el, kind: 'clipped-y', axis: 'y', over: overY });
    }
  }
  // 只保留最内层：若某问题容器的后代里也有同轴问题，则由后代代表。
  const flaggedEls = new Map(flagged.map(f => [f.el, f]));
  for (const f of flagged) {
    if (f.kind === 'scroll-x-undesigned' || f.kind === 'truncate-no-full-text') { f.keep = true; continue; }
    let innerFlagged = false;
    for (const g of flagged) if (g !== f && g.axis === f.axis && f.el.contains(g.el) && g.kind !== 'truncate-no-full-text') { innerFlagged = true; break; }
    f.keep = !innerFlagged;
  }
  for (const f of flagged) {
    if (!f.keep || issues.length >= MAX_ISSUES) continue;
    const c = f.kind === 'truncate-no-full-text' ? null : culprit(f.el, f.axis);
    if (f.kind !== 'truncate-no-full-text' && f.kind !== 'scroll-x-undesigned') {
      if (!c) continue;              // 溢出来自绝对定位 / 不可见元素，视觉上无影响
      if (c.media) continue;         // 装饰性媒体被裁切
    }
    issues.push({ kind: f.kind, selector: describe(f.el), text: snippet(f.el), over: Math.round(f.over), rect: rectOf(f.el), culprit: c });
  }
  void flaggedEls;
  return { viewport: { w: vw, h: window.innerHeight }, issues, designed };
}

/**
 * 贴边叠放判定（同样由 `page.evaluate(detectStacking)` 注入，必须自包含）。
 *
 * 「面」= 四边都有可见边框、非透明背景或投影（只有上 / 下分隔线的列表行不算），且圆角 ≥ 4px 的块级元素（卡片、通知、提示条、子卡片等）。
 * 同一父元素下相邻的两个面，在排列方向上间距 < MIN_GAP（默认 4px）且另一方向大部分重叠 → `stack-touching`。
 * 不算问题：衔接处两侧圆角都是 0（有意拼接成一组，如分段控件、表格行）、带 `data-mist-joined` 的容器、
 * 绝对 / 固定定位、不可见元素、表格行与单元格。
 */
export function detectStacking(options = {}) {
  const MIN_GAP = options.minGap ?? 4;
  const MAX_ISSUES = options.maxIssues ?? 200;
  const issues = [];
  const styleOf = new Map();
  const cs = el => { let s = styleOf.get(el); if (!s) { s = getComputedStyle(el); styleOf.set(el, s); } return s; };
  const alpha = c => { const m = /rgba?\(([^)]+)\)/.exec(c || ''); if (!m) return c && c !== 'transparent' ? 1 : 0; const p = m[1].split(/[\s,/]+/).filter(Boolean); return p.length > 3 ? parseFloat(p[3]) : 1; };
  const visible = el => { const s = cs(el); return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0 && !el.closest('details:not([open]) > :not(summary)'); };
  const SKIP = new Set(['TR', 'TD', 'TH', 'TBODY', 'THEAD', 'TABLE', 'OPTION', 'LI']);
  const surface = el => {
    if (SKIP.has(el.tagName) || el.closest('svg')) return false;
    const s = cs(el);
    if (['absolute', 'fixed'].includes(s.position) || s.display.startsWith('inline') && s.display !== 'inline-block' && s.display !== 'inline-flex' && s.display !== 'inline-grid') return false;
    const radius = Math.max(parseFloat(s.borderTopLeftRadius) || 0, parseFloat(s.borderBottomRightRadius) || 0);
    if (radius < 4) return false;
    const border = ['Top', 'Right', 'Bottom', 'Left'].every(k => parseFloat(s[`border${k}Width`]) > 0 && s[`border${k}Style`] !== 'none' && alpha(s[`border${k}Color`]) > 0.05);
    const bg = alpha(s.backgroundColor) > 0.05 || (s.backgroundImage && s.backgroundImage !== 'none');
    const shadow = s.boxShadow && s.boxShadow !== 'none';
    if (!(border || bg || shadow)) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 40 && r.height >= 16;
  };
  /** 无样式包裹层（只有一个可见子元素且尺寸一致）向下找到真正的面。 */
  const face = el => {
    for (let node = el, depth = 0; node && depth < 4; depth++) {
      if (surface(node)) return node;
      const kids = [...node.children].filter(visible);
      if (kids.length !== 1) return null;
      const a = node.getBoundingClientRect(), b = kids[0].getBoundingClientRect();
      if (Math.abs(a.top - b.top) > 1 || Math.abs(a.bottom - b.bottom) > 1 || Math.abs(a.left - b.left) > 1 || Math.abs(a.right - b.right) > 1) return null;
      node = kids[0];
    }
    return null;
  };
  const describe = el => {
    const parts = [];
    for (let node = el, depth = 0; node && node.nodeType === 1 && depth < 5; depth++, node = node.parentElement) {
      let part = node.tagName.toLowerCase();
      const classes = [...node.classList].filter(c => !/^(is-|_|css-)/.test(c)).slice(0, 2);
      if (classes.length) part += '.' + classes.join('.');
      const role = node.getAttribute('role'); if (role && !['presentation', 'none'].includes(role)) part += `[role=${role}]`;
      parts.unshift(part);
      if (node.classList.contains('mist-scroll') || node.getAttribute('role') === 'dialog') break;
    }
    return parts.join(' > ');
  };
  const snippet = el => (el?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const seen = new Set();
  for (const parent of document.body.getElementsByTagName('*')) {
    if (issues.length >= MAX_ISSUES) break;
    if (parent.closest('[data-mist-joined]') || !visible(parent)) continue;
    const kids = [...parent.children].filter(k => visible(k) && !['absolute', 'fixed'].includes(cs(k).position));
    for (let i = 0; i + 1 < kids.length; i++) {
      const a = face(kids[i]), b = face(kids[i + 1]);
      if (!a || !b) continue;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(), sa = cs(a), sb = cs(b);
      const overlapX = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), overlapY = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      let axis = null, gap = 0;
      if (overlapX > 0.5 * Math.min(ra.width, rb.width) && rb.top >= ra.top + ra.height / 2) { axis = 'y'; gap = rb.top - ra.bottom; if ((parseFloat(sa.borderBottomLeftRadius) || 0) + (parseFloat(sb.borderTopLeftRadius) || 0) === 0) continue; }
      else if (overlapY > 0.5 * Math.min(ra.height, rb.height) && rb.left >= ra.left + ra.width / 2) { axis = 'x'; gap = rb.left - ra.right; if ((parseFloat(sa.borderTopRightRadius) || 0) + (parseFloat(sb.borderTopLeftRadius) || 0) === 0) continue; }
      if (!axis || gap >= MIN_GAP || gap < -2) continue;
      const selector = describe(b);
      if (seen.has(selector + axis)) continue; seen.add(selector + axis);
      const r = { x: Math.round(rb.left), y: Math.round(rb.top), w: Math.round(rb.width), h: Math.round(rb.height) };
      issues.push({ kind: 'stack-touching', selector, text: snippet(b), over: Math.round(MIN_GAP - gap), rect: r, culprit: { selector: describe(a), text: snippet(a), over: Math.round(gap) }, axis });
    }
  }
  return { issues };
}
