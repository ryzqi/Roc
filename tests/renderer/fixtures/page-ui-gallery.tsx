import {ArrowRight, BookOpen} from 'lucide-react';
import {ActionButton} from '../../../src/renderer/shared/form-ui';
import {PageHeader, PageListRow, PageSection} from '../../../src/renderer/shared/page-ui';
import {EmptyState} from '../../../src/renderer/shell/EmptyState';
import {ErrorBar} from '../../../src/renderer/shell/ErrorBar';

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
  </main>;
}
