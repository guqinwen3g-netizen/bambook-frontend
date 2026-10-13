/** Mist Atelier 公共类型。所有组件的 tone 只允许这几种。 */
export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'bad' | 'ai';
export type Size = 'xs' | 'sm' | 'md' | 'lg';
export type StepState = 'done' | 'now' | 'todo' | 'blocked';
export type ThemeMode = 'light' | 'dark';

/** 把 neutral 转为 undefined，避免多余 data-tone 属性 */
export const toneAttr = (tone?: Tone) => (tone && tone !== 'neutral' ? tone : undefined);
export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');
