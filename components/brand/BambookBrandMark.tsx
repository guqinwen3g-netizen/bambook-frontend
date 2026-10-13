import React from 'react';
import { V3MotionMark } from './V3ConstructMark';
import type { V3Motion } from './V3ConstructMark';
import type { V3Form, V3State } from './V3BrandMark';
import '../../styles/bds/brand.css';

export interface BambookBrandMarkProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  size?: React.CSSProperties['width'];
  form?: V3Form;
  state?: V3State;
  motion?: V3Motion;
  palette?: 'inherit' | 'mist' | 'deep' | 'mono' | 'brand';
  paused?: boolean;
  speed?: number;
  replay?: number;
  settleToSolid?: boolean;
  label?: string;
}

export function BambookBrandCaption({className = ''}: {className?: string}) {
  return <span className={`bds-brand-caption ${className}`}><span className="bds-brand-caption__english">Bambook</span>{' '}竹衍</span>;
}

export function BambookBrandStatus({state = 'working', title, detail}: {
  state?: 'working' | 'error'; title: string; detail?: string;
}) {
  return <div className="bds-brand-status">
    <BambookBrandMark size={160} form="strands" motion="construct" state={state}/>
    <div className="bds-brand-status__title">{title}</div>
    {detail && <div className="bds-brand-status__detail">{detail}</div>}
  </div>;
}

/** One identity for the product, Agent and Icon Lab; never an operation icon. */
export function BambookBrandMark({
  size = 40, form = 'solid', state = 'still', motion = 'flow', palette = 'inherit',
  paused = false, speed = 1, replay = 0, settleToSolid = false, label, className = '', style, ...props
}: BambookBrandMarkProps) {
  return <span {...props} className={`bds-brand-mark ${className}`} style={{width: size, height: size, ...style}}
    data-bambook-brand="v3" data-palette={palette} data-brand-state={state}
    role={label ? 'img' : props.role} aria-label={label ?? props['aria-label']}
    aria-hidden={label || props['aria-label'] ? undefined : true}>
    <V3MotionMark form={form} state={state} motion={motion} paused={paused} speed={speed} replay={replay} settleToSolid={settleToSolid} size={200} />
  </span>;
}
