import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { Check, ChevronDown, Search, UploadCloud } from 'lucide-react';
import { Icon } from './primitives';
import { cx } from './types';

/** 表单栅格：默认两列；字段加 full 占满一行。 */
export function FormGrid({ cols = 2, children, style }: { cols?: 1 | 2 | 3; children: React.ReactNode; style?: React.CSSProperties }) {
  return <div className="mist-form" data-cols={cols === 2 ? undefined : cols} style={style}>{children}</div>;
}

export type FieldProps = { label: React.ReactNode; required?: boolean; hint?: React.ReactNode; error?: React.ReactNode; full?: boolean; children: React.ReactNode; htmlFor?: string };
/** 字段外框：标签 + 控件 + 提示/错误。error 存在时整个输入底变红色 tint。 */
export function Field({ label, required, hint, error, full, children, htmlFor }: FieldProps) {
  return (
    <label className="mist-field" data-full={full || undefined} data-error={error ? true : undefined} htmlFor={htmlFor}>
      <span className="mist-field-label">{label}{required && <em>*</em>}</span>
      {children}
      {(error || hint) && <span className="mist-field-hint">{error || hint}</span>}
    </label>
  );
}

type InputBase = { icon?: LucideIcon; suffix?: React.ReactNode; disabled?: boolean };
/** 单行输入。外层是填充底（无描边），聚焦变强调色浅底。 */
export const TextInput = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & InputBase>(function TextInput({ icon, suffix, className, disabled, ...rest }, ref) {
  return <span className={cx('mist-input', className)} data-disabled={disabled || undefined}>{icon && <Icon icon={icon} size="sm" />}<input ref={ref} disabled={disabled} {...rest} />{suffix && <span className="mist-input-suffix">{suffix}</span>}</span>;
});
export const TextArea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement> & InputBase>(function TextArea({ icon, className, disabled, rows = 3, ...rest }, ref) {
  return <span className={cx('mist-input', className)} data-multiline data-disabled={disabled || undefined}>{icon && <Icon icon={icon} size="sm" />}<textarea ref={ref} rows={rows} disabled={disabled} {...rest} /></span>;
});
/** 原生下拉（保证可访问性与移动端体验）。options 可为字符串或 {value,label}。 */
export function Select({ icon, options, placeholder, disabled, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement> & InputBase & { options: Array<string | { value: string; label: string }>; placeholder?: string }) {
  return (
    <span className="mist-input" data-disabled={disabled || undefined}>
      {icon && <Icon icon={icon} size="sm" />}
      <select disabled={disabled} {...rest}>
        {placeholder && <option value="">{placeholder}</option>}
        {options.map(o => typeof o === 'string' ? <option key={o} value={o}>{o}</option> : <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <Icon icon={ChevronDown} size="xs" />
    </span>
  );
}
export function SearchField({ value, onChange, placeholder = '搜索', autoFocus, style }: { value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean; style?: React.CSSProperties }) {
  return <label className="mist-search" style={style}><Icon icon={Search} size="sm" /><input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} autoFocus={autoFocus} aria-label={placeholder} /></label>;
}

export function Checkbox({ checked, onChange, label, tone, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: React.ReactNode; tone?: 'ok'; disabled?: boolean }) {
  return <label className="mist-check" data-tone={tone}><input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} /><span className="mist-check-box"><Icon icon={Check} size="xs" /></span>{label}</label>;
}
export function Switch({ checked, onChange, label, disabled, ariaLabel }: { checked: boolean; onChange: (v: boolean) => void; label?: React.ReactNode; disabled?: boolean; ariaLabel?: string }) {
  return <label className="mist-switch"><input type="checkbox" role="switch" aria-label={ariaLabel} checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} /><span className="mist-switch-track" />{label}</label>;
}

export type Choice<V extends string> = { value: V; title: React.ReactNode; description?: React.ReactNode; icon?: LucideIcon };
/** 选择卡（大单选）：用于「认可 / 需修改 / 不采用」这类关键决策。 */
export function ChoiceCards<V extends string>({ options, value, onChange, cols = 3, ariaLabel, disabled }: { options: Choice<V>[]; value: V; onChange: (v: V) => void; cols?: number; ariaLabel?: string; disabled?: boolean }) {
  return (
    <div className="mist-choices" role="radiogroup" aria-label={ariaLabel} style={{ ['--mist-choice-cols' as string]: cols }}>
      {options.map(o => (
        <button key={o.value} type="button" disabled={disabled} role="radio" aria-checked={o.value === value} className="mist-choice" onClick={() => onChange(o.value)}>
          <b>{o.icon && <Icon icon={o.icon} size="sm" />}{o.title}<span className="mist-radio" /></b>
          {o.description && <small>{o.description}</small>}
        </button>
      ))}
    </div>
  );
}

/** 上传区：点击或拖拽。onFiles 拿到 File[]。 */
export function UploadZone({ title = '拖拽文件到这里，或点击上传', hint, accept, multiple = true, onFiles }: { title?: React.ReactNode; hint?: React.ReactNode; accept?: string; multiple?: boolean; onFiles: (files: File[]) => void }) {
  const ref = React.useRef<HTMLInputElement>(null);
  const [over, setOver] = React.useState(false);
  return (
    <div className="mist-upload" data-over={over || undefined} role="button" tabIndex={0}
      onClick={() => ref.current?.click()} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') ref.current?.click(); }}
      onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={e => { e.preventDefault(); setOver(false); onFiles(Array.from(e.dataTransfer.files)); }}>
      <Icon icon={UploadCloud} size="lg" /><b>{title}</b>{hint && <span>{hint}</span>}
      <input ref={ref} type="file" hidden accept={accept} multiple={multiple} onChange={e => onFiles(Array.from(e.target.files || []))} />
    </div>
  );
}

/** 表单分节（创建/编辑页）：标题 + 说明 + 内容，节与节之间 1px 分隔。 */
export function FormSection({ id, title, description, children }: { id?: string; title: React.ReactNode; description?: React.ReactNode; children: React.ReactNode }) {
  return <section className="mist-form-section" id={id}><div className="mist-form-section-h"><div className="mist-h2">{title}</div>{description && <p>{description}</p>}</div>{children}</section>;
}
