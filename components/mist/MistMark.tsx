import React from 'react';
import { BAMBOOK_MARK_INNER } from './markSvg';

/** Bambook 六叶标志。颜色跟随 currentColor（浅色主题白色、深色主题品牌青）。 */
export function MistMark({ className = 'mist-brand-mark', title }: { className?: string; title?: string }) {
  const uid = React.useId().replace(/:/g, '');
  const html = React.useMemo(() => BAMBOOK_MARK_INNER.replace(/bb-knot-(\d)/g, `bb-knot-$1-${uid}`), [uid]);
  return (
    <svg className={className} viewBox="0 0 200 200" fill="currentColor" role={title ? 'img' : undefined}
      aria-label={title} aria-hidden={title ? undefined : true} dangerouslySetInnerHTML={{ __html: html }} />
  );
}

/** 标志 + 文字「Bambook 竹衍」 */
export function MistWordmark() {
  return <span className="mist-brand-word">Bambook<small>竹衍</small></span>;
}
