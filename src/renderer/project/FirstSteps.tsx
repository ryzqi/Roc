import {useEffect, useRef} from 'react';
import {formSecondaryButtonClass} from '../shared/form-ui';

export function FirstSteps({writable, requestId, onDismiss, onDiscover, onImport, onRead, onWrite}: {
  requestId: number;
  writable: boolean; onDismiss: () => void; onDiscover: () => void; onImport: () => void;
  onRead: () => void; onWrite: () => void;
}): React.JSX.Element {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (requestId === 0) return;
    heading.current?.focus({preventScroll: true});
    heading.current?.scrollIntoView({block: 'nearest'});
  }, [requestId]);
  return <section aria-labelledby="overview-first-steps-heading" data-testid="overview-first-steps"
    className="grid min-w-0 gap-3 border-t-[0.5px] border-line pt-4">
    <header className="flex items-center justify-between gap-3">
      <h2 ref={heading} tabIndex={-1} id="overview-first-steps-heading" className="rounded-control font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring">开始使用</h2>
      <button type="button" className={formSecondaryButtonClass} data-testid="overview-first-steps-skip" onClick={onDismiss}>跳过引导</button>
    </header>
    <ol className="grid list-decimal gap-3 pl-5 text-muted">
      <li><div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <span className="text-ink">加入资料</span>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={formSecondaryButtonClass} data-testid="overview-first-steps-discover" onClick={onDiscover}>检索论文</button>
          <button type="button" className={formSecondaryButtonClass} data-testid="overview-first-steps-import" disabled={!writable} onClick={onImport}>导入 PDF</button>
        </div>
      </div></li>
      <li><div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <span className="text-ink">阅读与记录</span>
        <button type="button" className={formSecondaryButtonClass} data-testid="overview-first-steps-read" onClick={onRead}>打开文献库</button>
      </div></li>
      <li><div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <span className="text-ink">撰写论文</span>
        <button type="button" className={formSecondaryButtonClass} data-testid="overview-first-steps-write" onClick={onWrite}>打开写作</button>
      </div></li>
    </ol>
  </section>;
}
