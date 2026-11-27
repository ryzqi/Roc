import {Check, Copy} from 'lucide-react';
import {useEffectiveReducedMotion} from './motion-preference';
import './copy-feedback-icon.css';

/** Both glyphs occupy one stable slot; feedback follows the clipboard receipt. */
export function CopyFeedbackIcon({copied, size = 14}: {copied: boolean; size?: number}): React.JSX.Element {
  const reduced = useEffectiveReducedMotion();
  return <span className="copy-feedback-icon" data-copied={copied}
    data-motion-reduced={reduced || undefined} aria-hidden="true" style={{width: size, height: size}}>
    <span className="copy-feedback-icon__copy"><Copy size={size}/></span>
    <span className="copy-feedback-icon__check"><Check size={size}/></span>
  </span>;
}
