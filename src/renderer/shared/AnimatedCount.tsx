import {AnimatePresence, m} from 'motion/react';
import {getMotionVariants} from './motion';
import {useEffectiveReducedMotion} from './motion-preference';

/** Only the units glyph moves; the accessible value is always the current count. */
export function AnimatedCount({value}: {value: number}): React.JSX.Element {
  const formatted = value.toLocaleString('zh-CN');
  const unit = formatted.slice(-1);
  return <span style={{fontVariantNumeric: 'tabular-nums'}}>
    <span className="sr-only">{formatted}</span>
    <span aria-hidden="true">
      <span>{formatted.slice(0, -1)}</span>
      <span style={{display: 'inline-grid', position: 'relative', width: '1ch'}}>
        <AnimatePresence initial={false}>
          <CountGlyph key={unit} value={unit}/>
        </AnimatePresence>
      </span>
    </span>
  </span>;
}

function CountGlyph({value}: {value: string}): React.JSX.Element {
  const reduced = useEffectiveReducedMotion();
  return <m.span style={{gridArea: '1 / 1'}} variants={getMotionVariants('number', reduced, 1)}
    transformTemplate={reduced ? () => 'none' : undefined}
    initial="initial" animate="animate" exit="exit">{value}</m.span>;
}
