import {useState} from 'react';
import type {OpenReviewEntry} from '../../shared/schemas/research-openreview';

const jsonText = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
export default function OpenReviewEntryView({entry}: {entry: OpenReviewEntry}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const value = entry.kind === 'note' ? entry.note : entry.edit;
  const title = entry.kind === 'note' && typeof entry.note.content.title?.value === 'string' ? entry.note.content.title.value : null;
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)} data-testid="reader-openreview-entry">
    <summary className="cursor-pointer break-words">{entry.kind === 'edit' ? '修改差量' : entry.note.id === entry.note.forum ? '论文' : '公开回复'}
      <span className="ml-2 font-mono">{value.id}</span>{title === null ? null : <span className="ml-2">{title}</span>}</summary>
    {open ? <div className="space-y-2 py-2">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-muted">
        <dt>来源 SHA-256</dt><dd className="break-all font-mono">{entry.sourceHash}</dd>
        <dt>所属会议或域</dt><dd className="break-all">{value.domain ?? '未报告'}</dd>
        <dt>公开读者</dt><dd className="break-all">{value.readers.join(', ')}</dd>
        <dt>排除读者</dt><dd className="break-all">{value.nonreaders.length === 0 ? '无' : value.nonreaders.join(', ')}</dd>
        <dt>签名</dt><dd className="break-all">{value.signatures.join(', ')}</dd>
        <dt>服务器创建时间</dt><dd>{value.tcdate ?? '未报告'}</dd>
        <dt>服务器修改时间</dt><dd>{value.tmdate ?? '未报告'}</dd>
        <dt>来源创建时间</dt><dd>{value.cdate ?? '未报告'}</dd>
        <dt>来源修改时间</dt><dd>{value.mdate ?? '未报告'}</dd>
        <dt>删除时间</dt><dd>{value.ddate ?? '未报告'}</dd>
        {entry.kind === 'note' ? <>
          <dt>论坛</dt><dd className="break-all font-mono">{entry.note.forum}</dd>
          <dt>回复目标</dt><dd className="break-all font-mono">{entry.note.replyto ?? '无'}</dd>
          <dt>Invitations</dt><dd className="break-all">{entry.note.invitations.join(', ')}</dd>
          <dt>许可</dt><dd className="break-words">{entry.note.license ?? '未报告'}</dd>
          <dt>发表时间</dt><dd>{entry.note.pdate ?? '未报告'}</dd>
          <dt>公开时间</dt><dd>{entry.note.odate ?? '未报告'}</dd>
        </> : <>
          <dt>Invitation</dt><dd className="break-all">{entry.edit.invitation}</dd>
          <dt>目标 Note</dt><dd className="break-all font-mono">{jsonText(entry.edit.note.id)}</dd>
          <dt>整项替换</dt><dd>{entry.edit.replacement === null ? '未报告' : entry.edit.replacement ? '是' : '否'}</dd>
        </>}
      </dl>
      {entry.kind === 'note' ? <dl className="space-y-2" data-testid="reader-openreview-content">
        {Object.entries(entry.note.content).map(([name, field]) => <div key={name}>
          <dt className="font-medium break-all">{name}</dt><dd><pre className="whitespace-pre-wrap break-words font-[inherit]">{jsonText(field.value)}</pre>
            <p className="text-muted">字段读者：{field.readers === null ? '继承公开 Note' : field.readers.join(', ')}</p></dd>
        </div>)}
      </dl> : <>
        <p className="text-muted">差量包含修改操作，未重建完整历史 Note。</p>
        <pre className="whitespace-pre-wrap break-words font-mono" data-testid="reader-openreview-delta">{JSON.stringify(entry.edit.note, null, 2)}</pre>
        {entry.edit.content === null ? null : <details><summary className="cursor-pointer text-muted">Edit 附加内容</summary>
          <pre className="whitespace-pre-wrap break-words font-mono">{JSON.stringify(entry.edit.content, null, 2)}</pre></details>}
      </>}
    </div> : null}
  </details>;
}
