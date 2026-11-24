import {ArrowRight, BookOpen} from 'lucide-react';
import {useRef, useState} from 'react';
import {ActionButton} from '../../../src/renderer/shared/form-ui';
import {ActionStatus, TransientStatus} from '../../../src/renderer/shared/action-status';
import {PageHeader, PageListRow, PageSection} from '../../../src/renderer/shared/page-ui';
import {EmptyState} from '../../../src/renderer/shell/EmptyState';
import {ErrorBar} from '../../../src/renderer/shell/ErrorBar';

function FeedbackSamples(): React.JSX.Element {
  const nextCompletion = useRef(0);
  const [completion, setCompletion] = useState<number | null>(null);
  return <div className="grid gap-2 text-muted" data-testid="gallery-feedback">
    <ActionStatus state="pending">正在保存笔记…</ActionStatus>
    <ActionStatus state="success">文献已收录，知识处理尚未完成。</ActionStatus>
    <ActionStatus state="error" testId="gallery-feedback-error">保存失败，保留草稿后可重试。</ActionStatus>
    <div role="status" data-testid="gallery-feedback-receipt">
      <TransientStatus completionId={completion} announce={false} testId="gallery-feedback-success">笔记已保存</TransientStatus>
    </div>
    <div className="flex flex-wrap gap-2">
      <ActionButton variant="compact" onClick={() => setCompletion(++nextCompletion.current)} data-testid="gallery-feedback-complete">完成一次保存</ActionButton>
      <ActionButton variant="compact" onClick={() => setCompletion(null)} data-testid="gallery-feedback-switch">切换对象</ActionButton>
    </div>
  </div>;
}

export function PageUiGallery({onAction}: {onAction: (action: string) => void}): React.JSX.Element {
  return <main className="mx-auto grid max-w-[1120px] gap-6 p-6" data-testid="page-gallery">
    <PageHeader title="科学证据与可重复研究" description="核对方法、实验条件与原始来源。"
      status={<span className="text-[length:var(--font-meta-size)] text-muted">进行中</span>}
      action={<ActionButton variant="primary" onClick={() => onAction('start')}>开始研究</ActionButton>} />
    <PageSection title="近期文献" action={<ActionButton variant="compact" onClick={() => onAction('all')}>全部文献</ActionButton>}>
      <ul className="grid gap-1">
        <li><PageListRow title="实验条件与开放数据的复核方法" description="2026 年" leading={<BookOpen size={16}/>}
          trailing={<ArrowRight size={16} aria-hidden="true"/>} data-testid="page-row" onClick={() => onAction('open')}/></li>
        <li><PageListRow title="当前阅读的研究方法" description="当前文献" aria-current="true"
          data-testid="page-row-current" onClick={() => onAction('current')}/></li>
        <li><PageListRow title="当前项目不可修改" description="已归档，仍可阅读原始资料。" disabled
          data-testid="page-row-disabled" onClick={() => onAction('disabled')}/></li>
      </ul>
    </PageSection>
    <PageSection title="近期成果"><EmptyState compact title="尚无研究成果" description="完成任务后可在这里查看保存的成果。"/></PageSection>
    <PageSection title="当前任务"><EmptyState compact tone="loading" title="正在读取任务"/></PageSection>
    <PageSection title="读取失败"><ErrorBar error={{level:'page', message:'文献来源暂时无法读取。', retry:() => onAction('retry')}}/></PageSection>
    <PageSection title="工作目录"><ErrorBar error={{level:'blocked', message:'工作目录未绑定。', actionLabel:'从项目设置选择目录。'}}/></PageSection>
    <PageSection title="动作反馈"><FeedbackSamples /></PageSection>
  </main>;
}
