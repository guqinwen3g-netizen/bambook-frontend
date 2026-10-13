/**
 * 开发者选项 —— v0.8 预览期开发 / 演示工具的集中开关。
 * 持久化于 localStorage，跨会话保留；
 * subscribe 模式：getDevOptions 读快照，subscribe 监听变更并立即回调一次。
 */
export interface DevOptions {
  /** 开发者模式总开关：开启后设置页显示「开发者选项」导航 */
  developerMode: boolean;
  /** 装修遮挡：控制占位页磨砂覆盖层显隐（v0.8 未交付模块默认遮挡） */
  comingSoonOverlay: boolean;
  /** 演示账号快速切换：控制开发者选项内演示账号面板显隐 */
  demoAccountSwitch: boolean;
}

const DEV_OPTIONS_KEY = 'bambook_dev_options';

const DEFAULT_DEV_OPTIONS: DevOptions = {
  developerMode: false,
  // 2026-08-28 运维冲刺任务 5：投产默认不遮挡（原默认 true 导致全新安装首页即被糊住）
  comingSoonOverlay: false,
  demoAccountSwitch: true,
};

const listeners = new Set<(options: DevOptions) => void>();
let cache: DevOptions | null = null;

const read = (): DevOptions => {
  try {
    const raw = localStorage.getItem(DEV_OPTIONS_KEY);
    if (!raw) return { ...DEFAULT_DEV_OPTIONS };
    return { ...DEFAULT_DEV_OPTIONS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_DEV_OPTIONS };
  }
};

export const getDevOptions = (): DevOptions => {
  if (!cache) cache = read();
  return cache;
};

const persist = (next: DevOptions): void => {
  cache = next;
  try {
    localStorage.setItem(DEV_OPTIONS_KEY, JSON.stringify(next));
  } catch {
    /* 持久化失败不阻断功能 */
  }
  listeners.forEach(fn => fn(next));
};

export const setDevOption = <K extends keyof DevOptions>(key: K, value: DevOptions[K]): void => {
  persist({ ...getDevOptions(), [key]: value });
};

export const subscribe = (fn: (options: DevOptions) => void): (() => void) => {
  listeners.add(fn);
  fn(getDevOptions());
  return () => {
    listeners.delete(fn);
  };
};
