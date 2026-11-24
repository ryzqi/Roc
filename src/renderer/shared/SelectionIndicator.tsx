import { m } from 'motion/react';
import { motionTransitions } from './motion';

/** The owner supplies an instance-scoped identity; selection and focus stay on its control. */
export function SelectionIndicator({ layoutId, className, testId }: {
  layoutId: string;
  className: string;
  testId: string;
}): React.JSX.Element {
  return <m.span aria-hidden="true" layoutId={layoutId} initial={false}
    transition={motionTransitions.selection} className={`pointer-events-none absolute ${className}`}
    data-testid={testId} data-selection-id={layoutId} />;
}
