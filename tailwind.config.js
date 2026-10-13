/** @type {import('tailwindcss').Config} */
// Local Tailwind v3 configuration — replaces the runtime CDN
// (cdn.tailwindcss.com Play CDN) used during early prototyping.
// Build-time JIT generates only the utilities actually referenced
// in the listed content files, keeping the emitted CSS small.
import typography from '@tailwindcss/typography';

export default {
  content: [
    './index.html',
    './index.tsx',
    './App.tsx',
    './types.ts',
    './components/**/*.{ts,tsx,js,jsx}',
    './pwa/**/*.{ts,tsx,js,jsx}',
    './lib/**/*.{ts,tsx,js,jsx}',
    './services/**/*.{ts,tsx,js,jsx}',
    './utils/**/*.{ts,tsx,js,jsx}',
    './config/**/*.{ts,tsx,js,jsx}',
  ],
  // dark: 'class' so isDarkMode toggles via document root class.
  // Renderer code already uses `dark:` variants extensively.
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        // Match the runtime body font set in index.html.
        // HarmonyOS Sans SC (designer-chosen CJK) is bundled locally via the
        // harmonyos-sans-sc-webfont-splitted npm package and imported at the
        // top of index.css.
        sans: [
          'Urbanist',
          'HarmonyOS Sans SC',
          'Inter',
          'Acherus Grotesque',
          'PingFang SC',
          'Microsoft YaHei',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Helvetica Neue',
          'sans-serif',
        ],
        // 等宽栈 — JetBrains Mono 优先（@fontsource 本地加载 Light 300，
        // 与全局 ≤300 纪律同重）；此前 font-mono 走 Tailwind 默认栈落到 Menlo 400，
        // 造成数字/单号场景比正文粗的隐性错配。
        mono: [
          'JetBrains Mono',
          'SF Mono',
          'Menlo',
          'Consolas',
          'monospace',
        ],
      },
      // ── BDS 字重刻度 — Thin-first 纪律（单一真源，全局长效） ──
      // 全局 Light 300 单一字重（2026-08-14 用户裁决，2026-09-01 二次确认）：
      // 所有字重工具类坍缩到 300：写 font-bold 也得 300，从机制上杜绝过重字重。
      // 强调靠墨色层级与字号，绝不靠字重。HarmonyOS Sans SC 有真实 Light 300 面，
      // CJK 与拉丁（Urbanist 300）同重渲染，无中西文字重错配。
      // 注：2026-09-01 曾试正文 400，用户实机反馈「超过预期的粗细」回滚——
      // 清晰度问题由字号 +1px 解决（见 fontSize），不靠字重。
      fontWeight: {
        thin: 100,
        extralight: 200,
        light: 300,
        normal: 300,      // 生产 body 默认 300
        medium: 300,      // 原 500 → 坍缩至 300（≤300 无例外）
        semibold: 300,    // 原 600 → 坍缩至 300
        bold: 300,        // 原 700 → 坍缩至 300
        extrabold: 300,
        black: 300,
      },
      // ── BDS 字号刻度对齐（2026-09-01 拍板：字号双轨归一；同日 +1px 修订） ──
      // 根因：Tailwind 默认与 BDS token 双轨 ±1px 并存，归一方向：对齐 token。
      // 同日修订：11px 中文低于可读硬底（CJK 笔画密度高，12px 以下发虚）——
      // 用户实机反馈「清晰度没有之前明显」，四档 +1px 回调（12/14/16/18），
      // 清晰度靠字号不靠字重，tokens.css --text-* 同步保持双轨同源。
      // lineHeight 保留 Tailwind 默认值——行盒高度不变、布局零重排。
      fontSize: {
        xs: ['12px', { lineHeight: '1rem' }],
        sm: ['14px', { lineHeight: '1.25rem' }],
        base: ['16px', { lineHeight: '1.5rem' }],
        lg: ['18px', { lineHeight: '1.75rem' }],
        xl: ['20px', { lineHeight: '1.75rem' }],
        '2xl': ['24px', { lineHeight: '2rem' }],
        '3xl': ['32px', { lineHeight: '2.5rem' }],   // 默认 30px → token 32px
      },
      // ── BDS 字距刻度（2026-10-01 补齐：此前 Tailwind 默认值与 tokens.css 双轨） ──
      // 根因：Tailwind 默认 wide=0.025em / wider=0.05em / widest=0.1em，
      // 而 tokens.css 是 wide=0.04em / wider=0.08em / widest=0.12em —— 同一语义类两值。
      // 归一方向：与 fontSize 一致，对齐 token（见 fontSize 处同源注释）。
      // 注意：tracking-wider/widest 现值较默认**更宽**，属意图保留微调，视觉差异约 0.02em。
      letterSpacing: {
        'tight': 'var(--tracking-tight)',
        'normal': 'var(--tracking-normal)',
        'wide': 'var(--tracking-wide)',
        'wider': 'var(--tracking-wider)',
        'widest': 'var(--tracking-widest)',
        'caps': 'var(--tracking-caps)',            // 0.14em 表单 label / 分区标签
        'caps-wide': 'var(--tracking-caps-wide)',  // 0.18em 大写分组标题
      },
      // ── BDS 浮层宽度档（2026-10-01 补齐，收编 29 处 inline width）──
      width: {
        'modal-sm': 'var(--modal-w-sm)',
        'modal-md': 'var(--modal-w-md)',
        'modal-lg': 'var(--modal-w-lg)',
        'modal-xl': 'var(--modal-w-xl)',
        'modal-2xl': 'var(--modal-w-2xl)',
      },
      // ── Bambook Flat Design 圆角 token（legacy 语义类，视觉零变化保留） ──
      // v2.2 收编（2026-08-16）：值从裸 px 改为 var() 引用，全部指向
      // styles/bds/tokens.css 同心层级刻度——legacy 轨与 BDS 轨从此同源，
      // 裸值只许存在于 tokens.css。值与原裸值完全一致，视觉零变化。
      borderRadius: {
        'panel': 'var(--radius-2xl)',      // 34px 页面级面板
        'card': 'var(--radius-lg)',        // 24px 标准卡片
        'card-lg': 'var(--radius-card-lg)',// 28px 工具栏/大按钮
        'inset': 'var(--radius-inset)',    // 22px 列表行/嵌套卡
        'floating': 'var(--radius-xl)',    // 30px 浮层/大卡
        'control': 'var(--radius-control)',// 18px 控件签名圆角
        'field': 'var(--radius-md)',       // 16px 输入框
        'compact': 'var(--radius-compact)',// 14px 小标签/统计块
        // ── BDS v2.2 同心层级刻度（styles/bds/tokens.css var 引用，主题无关） ──
        'bds-xs': 'var(--radius-xs)',       // 8px  tooltip/小标签
        'bds-sm': 'var(--radius-sm)',       // 12px 导航项/列表行
        'bds-compact': 'var(--radius-compact)',   // 14px 小标签/统计块（v2.2）
        'bds-md': 'var(--radius-md)',       // 16px 输入框/嵌套小卡
        'bds-control': 'var(--radius-control)',   // 18px 控件签名圆角（v2.2）
        'bds-inset': 'var(--radius-inset)',       // 22px 列表行/嵌套卡（v2.2）
        'bds-lg': 'var(--radius-lg)',       // 24px 标准卡片
        'bds-card-lg': 'var(--radius-card-lg)',   // 28px 工具栏/大按钮（v2.2）
        'bds-xl': 'var(--radius-xl)',       // 30px 大卡/模态
        'bds-2xl': 'var(--radius-2xl)',     // 34px 页面级面板（Bambook panel 签名）
        'bds-pill': 'var(--radius-pill)',   // 999px 按钮/徽章/分段器
      },
      // ── Bambook 业务色 token ──
      // 映射 os-vnext.css 中 --bambook-*-rgb token 到语义类，
      // 组件用 bg-deep / text-link 等，支持 alpha 修饰符（bg-deep/40）。
      // 值与原硬编码完全一致，替换后视觉零变化。
      colors: {
        'deep': 'rgb(var(--bambook-bg-deep-rgb) / <alpha-value>)',
        'deep-alt': 'rgb(var(--bambook-bg-deep-alt-rgb) / <alpha-value>)',
        'app-dark': 'rgb(var(--os-vnext-bg-dark-rgb) / <alpha-value>)',
        'app-light': 'rgb(var(--os-vnext-bg-light-rgb) / <alpha-value>)',
        'action': 'rgb(var(--bambook-brand-action-rgb) / <alpha-value>)',
        'link': 'rgb(var(--bambook-brand-link-rgb) / <alpha-value>)',
        // ── BDS v2 语义色（styles/bds/tokens.css；rgb 三元组支持 alpha 修饰符） ──
        // 新代码优先使用：bg-accent / text-accent / bg-success / text-danger 等
        'accent': 'rgb(var(--accent-rgb) / <alpha-value>)',
        'success': 'rgb(var(--success-rgb) / <alpha-value>)',
        'warning': 'rgb(var(--warning-rgb) / <alpha-value>)',
        'danger': 'rgb(var(--danger-rgb) / <alpha-value>)',
        // BDS v2 表面色（rgb 三元组，支持 alpha 修饰符，随 [data-theme] 暗色自动翻转）
        'bds-page': 'rgb(var(--bg-page-rgb) / <alpha-value>)',
        'bds-card': 'rgb(var(--bg-card-rgb) / <alpha-value>)',
        'bds-panel': 'rgb(var(--bg-panel-rgb) / <alpha-value>)',
        'bds-sunken': 'rgb(var(--bg-sunken-rgb) / <alpha-value>)',
        'bds-raised': 'rgb(var(--bg-raised-rgb) / <alpha-value>)',
        'bds-ink': 'var(--text-primary)',
        'bds-ink-2': 'var(--text-secondary)',
        'bds-ink-3': 'var(--text-tertiary)',
        'bds-ink-4': 'var(--text-quaternary)',
        'bds-link': 'rgb(var(--link-rgb) / <alpha-value>)',
      },
    },
  },
  plugins: [
    // EmailManager renders rich-text email bodies via `prose prose-slate`.
    typography,
  ],
};
